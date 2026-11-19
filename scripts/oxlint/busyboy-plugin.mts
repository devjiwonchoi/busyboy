import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// https://nextjs.org/docs/app/api-reference/file-conventions/error
const SERVER_SEGMENT_FILE =
  /[\\/]app[\\/](?:.*[\\/])?(?:page|layout|template|default|loading|not-found|forbidden|unauthorized)\.[jt]sx?$/;

type Node = { type: string; [key: string]: unknown };
type Context = {
  filename: string;
  report(descriptor: { node: Node; message: string }): void;
};

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const webDirectory = ["apps", "web"].join(sep);
const appDirectory = [webDirectory, "app"].join(sep);
const guard = "requireTrustedRequest";
const proxyFile = /^apps[/\\]web[/\\](?:src[/\\])?(?:proxy|middleware)\.[cm]?[jt]sx?$/;
const routeFile = /^route\.[cm]?[jt]sx?$/;
const componentFile = /^(?:page|layout|default|template)\.[jt]sx$/;

function repositoryPath(context: Context) {
  return relative(repositoryRoot, context.filename);
}

function isUseServer(program: Node) {
  const [first] = program.body as Node[];
  return first?.type === "ExpressionStatement" && first.directive === "use server";
}

function functionOf(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  if (node.type === "FunctionDeclaration") return node;
  if (node.type !== "VariableDeclaration") return undefined;
  const [declarator] = node.declarations as Node[];
  const init = declarator?.init as Node | undefined;
  if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") return init;
  return undefined;
}

function startsWithGuard(fn: Node) {
  const body = fn.body as Node;
  if (body.type !== "BlockStatement") return false;
  const [first] = body.body as Node[];
  if (first?.type !== "ExpressionStatement") return false;
  const expression = first.expression as Node;
  if (expression.type !== "AwaitExpression") return false;
  const call = expression.argument as Node;
  const callee = call.type === "CallExpression" ? (call.callee as Node) : undefined;
  return callee?.type === "Identifier" && callee.name === guard;
}

function entries(program: Node, everyAsyncFunction: boolean) {
  const found: Node[] = [];
  const loose: Node[] = [];
  for (const statement of program.body as Node[]) {
    if (
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ) {
      const fn = functionOf(statement.declaration as Node | null);
      if (fn) found.push(fn);
      else if (
        statement.type === "ExportNamedDeclaration" &&
        (statement.specifiers as Node[]).length
      )
        loose.push(statement);
      continue;
    }
    const fn = everyAsyncFunction ? functionOf(statement) : undefined;
    if (fn?.async) found.push(fn);
  }
  return { found: everyAsyncFunction ? found.filter((fn) => fn.async) : found, loose };
}

const noProxy = {
  meta: { type: "problem" },
  create(context: Context) {
    return {
      Program(program: Node) {
        if (!proxyFile.test(repositoryPath(context))) return;
        context.report({
          node: program,
          message: "BusyBoy has no proxy. Start each entry with `await requireTrustedRequest();`.",
        });
      },
    };
  },
};

function reportUnguardedEntries(context: Context, program: Node, component: boolean) {
  const { found, loose } = entries(program, component);
  for (const statement of loose) {
    context.report({
      node: statement,
      message: "Export an entry where it is declared, so the request check can be verified.",
    });
  }
  for (const fn of found) {
    if (startsWithGuard(fn)) continue;
    context.report({
      node: fn,
      message: "Start this entry with `await requireTrustedRequest();`.",
    });
  }
}

const trustedEntry = {
  meta: { type: "problem" },
  create(context: Context) {
    return {
      Program(program: Node) {
        const path = repositoryPath(context);
        if (!path.startsWith(webDirectory + sep)) return;
        const inApp = path.startsWith(appDirectory + sep);
        const name = basename(path);
        const component = inApp && componentFile.test(name);
        const route = inApp && routeFile.test(name);
        if (component || route || isUseServer(program))
          reportUnguardedEntries(context, program, component);
      },
    };
  },
};

const noUseClientSegment = {
  meta: { type: "problem" },
  create(context: Context) {
    if (!SERVER_SEGMENT_FILE.test(context.filename)) return {};
    return {
      Program(program: { body: Node[] }) {
        for (const statement of program.body) {
          if (statement.directive === undefined) break;
          if (statement.directive !== "use client") continue;
          context.report({
            node: statement,
            message:
              'Route segment files stay Server Components. Move the interactive part into a "use client" component and render it from here.',
          });
        }
      },
    };
  },
};

const effectHooks = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

function calledHookName(callee: Node): string | undefined {
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return ((callee.property as Node).name as string | undefined) ?? undefined;
  }
  return undefined;
}

const noUnreasonedEffect = {
  meta: { type: "suggestion" },
  create(context: Context) {
    return {
      CallExpression(call: Node) {
        const name = calledHookName(call.callee as Node);
        if (!name || !effectHooks.has(name)) return;
        context.report({
          node: call,
          message:
            "Reconsider this effect (https://react.dev/learn/you-might-not-need-an-effect). " +
            "Computable from props or state? Compute it during render. " +
            "Caused by a user action? Do it in that handler. " +
            "Resets state when a prop changes? Key the component on that prop. " +
            "Reads a value a non-React store already holds? Use useSyncExternalStore. " +
            "An effect is right only when it keeps something outside React in step while the component is mounted, " +
            "such as a connection, subscription, timer, or DOM integration. Then say what on the line above: " +
            "`// oxlint-disable-next-line busyboy/no-unreasoned-effect -- <what it keeps in step>`. " +
            "Moving the same logic into a ref callback or store to avoid this rule is not a fix.",
        });
      },
    };
  },
};

const predicateName = /^(?:is|has|can|should|needs|was|did)[A-Z]/;

function negatedPredicates(expression: Node | undefined): Node[] {
  if (!expression) return [];
  if (expression.type === "LogicalExpression") {
    return [
      ...negatedPredicates(expression.left as Node),
      ...negatedPredicates(expression.right as Node),
    ];
  }
  if (expression.type !== "UnaryExpression" || expression.operator !== "!") return [];
  let argument = expression.argument as Node;
  if (argument.type === "AwaitExpression") argument = argument.argument as Node;
  if (argument.type !== "CallExpression") return [];
  const callee = argument.callee as Node;
  if (callee.type === "Identifier" && predicateName.test(callee.name as string))
    return [expression];
  return [];
}

const noNegatedPredicate = {
  meta: { type: "suggestion" },
  create(context: Context) {
    return {
      IfStatement(statement: Node) {
        for (const node of negatedPredicates(statement.test as Node)) {
          context.report({
            node,
            message:
              "Branch on a positive predicate instead of negating one: name the case the branch handles " +
              "(`isSetupIncomplete()` rather than `!isSetupComplete()`), or flip the branches so the if tests the predicate as is.",
          });
        }
      },
    };
  },
};

function isEmptyValue(node: Node | null | undefined): boolean {
  if (!node) return true;
  if (node.type === "Literal") return node.value === null;
  if (node.type === "Identifier") return node.name === "undefined";
  return false;
}

function isSuspenseName(name: Node): boolean {
  if (name.type === "JSXIdentifier") return name.name === "Suspense";
  if (name.type === "JSXMemberExpression") return (name.property as Node).name === "Suspense";
  return false;
}

function reportEmptyFallback(context: Context, element: Node) {
  const attributes = element.attributes as Node[];
  if (attributes.some((attribute) => attribute.type === "JSXSpreadAttribute")) return;
  const fallback = attributes.find((attribute) => (attribute.name as Node).name === "fallback");
  const value = fallback?.value as Node | null | undefined;
  if (
    fallback &&
    !(value?.type === "JSXExpressionContainer" && isEmptyValue(value.expression as Node))
  )
    return;
  context.report({
    node: fallback ?? element,
    message:
      "Give <Suspense> a fallback that holds the space of what it waits for, such as a <Skeleton />. A missing or null fallback renders nothing.",
  });
}

const noEmptySuspenseFallback = {
  meta: { type: "problem" },
  create(context: Context) {
    return {
      JSXOpeningElement(element: Node) {
        if (isSuspenseName(element.name as Node)) reportEmptyFallback(context, element);
      },
    };
  },
};

const LOADING_FILE = /[\\/]app[\\/](?:.*[\\/])?loading\.[jt]sx?$/;

function defaultExportedFunction(program: Node): Node | undefined {
  const body = program.body as Node[];
  const statement = body.find((node) => node.type === "ExportDefaultDeclaration");
  const declaration = statement?.declaration as Node | undefined;
  if (!declaration) return undefined;
  if (
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "FunctionExpression" ||
    declaration.type === "ArrowFunctionExpression"
  )
    return declaration;
  if (declaration.type !== "Identifier") return undefined;
  for (const node of body) {
    const fn = functionOf(node);
    if (!fn) continue;
    const id =
      node.type === "FunctionDeclaration"
        ? (node.id as Node)
        : ((node.declarations as Node[])[0].id as Node);
    if (id?.name === declaration.name) return fn;
  }
  return undefined;
}

function emptyReturns(node: Node, found: Node[]): Node[] {
  if (node.type === "ReturnStatement") {
    if (isEmptyValue(node.argument as Node | null)) found.push(node);
    return found;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") continue;
    for (const item of Array.isArray(child) ? child : [child]) {
      if (!item || typeof item !== "object" || typeof (item as Node).type !== "string") continue;
      const type = (item as Node).type;
      if (
        type === "FunctionDeclaration" ||
        type === "FunctionExpression" ||
        type === "ArrowFunctionExpression"
      )
        continue;
      emptyReturns(item as Node, found);
    }
  }
  return found;
}

const noEmptyLoading = {
  meta: { type: "problem" },
  create(context: Context) {
    if (!LOADING_FILE.test(context.filename)) return {};
    return {
      Program(program: Node) {
        const fn = defaultExportedFunction(program);
        if (!fn) return;
        const body = fn.body as Node;
        const offenders =
          body.type === "BlockStatement"
            ? emptyReturns(body, [])
            : isEmptyValue(body)
              ? [body]
              : [];
        for (const node of offenders) {
          context.report({
            node,
            message:
              "loading.tsx must render a placeholder that holds the space of the segment, such as a <Skeleton />. Returning null renders nothing.",
          });
        }
      },
    };
  },
};

const testsDirectory = [webDirectory, "tests"].join(sep);
const e2eDirectory = [testsDirectory, "e2e"].join(sep);
const e2eHelpersFolder = "utils";
const e2eTestFile = /\.e2e\.ts$/;

function e2eLayoutProblem(path: string) {
  if (!path.startsWith(testsDirectory + sep)) return undefined;
  if (!path.startsWith(e2eDirectory + sep))
    return "Put e2e tests in apps/web/tests/e2e and the code they share in apps/web/tests/e2e/utils.";
  const parts = relative(e2eDirectory, path).split(sep);
  const isTest = e2eTestFile.test(path);
  if (parts.length === 1 && isTest) return undefined;
  if (parts.length === 1)
    return "Only *.e2e.ts tests sit in apps/web/tests/e2e. Move shared code to apps/web/tests/e2e/utils.";
  if (parts.length === 2 && parts[0] === e2eHelpersFolder && !isTest) return undefined;
  if (parts.length === 2 && parts[0] === e2eHelpersFolder)
    return "apps/web/tests/e2e/utils holds shared code only. Move the test up to apps/web/tests/e2e.";
  return "Keep apps/web/tests/e2e flat: tests directly in it, shared code directly in apps/web/tests/e2e/utils.";
}

function isTestExtend(callee: Node) {
  if (callee.type !== "MemberExpression") return false;
  const object = callee.object as Node;
  const property = callee.property as Node;
  return (
    object.type === "Identifier" &&
    object.name === "test" &&
    property.type === "Identifier" &&
    property.name === "extend"
  );
}

const flatE2e = {
  meta: { type: "problem" },
  create(context: Context) {
    const path = repositoryPath(context);
    if (!path.startsWith(testsDirectory + sep)) return {};
    return {
      Program(program: Node) {
        const message = e2eLayoutProblem(path);
        if (message) context.report({ node: program, message });
      },
      CallExpression(node: Node) {
        if (isTestExtend(node.callee as Node))
          context.report({
            node,
            message:
              "Write e2e setup inline or in a beforeEach and share it from apps/web/tests/e2e/utils, not as a test.extend fixture.",
          });
      },
    };
  },
};

const busyboyPlugin = {
  meta: { name: "busyboy" },
  rules: {
    "no-use-client-segment": noUseClientSegment,
    "no-proxy": noProxy,
    "trusted-entry": trustedEntry,
    "no-unreasoned-effect": noUnreasonedEffect,
    "no-empty-suspense-fallback": noEmptySuspenseFallback,
    "no-empty-loading": noEmptyLoading,
    "no-negated-predicate": noNegatedPredicate,
    "flat-e2e": flatE2e,
  },
};

export default busyboyPlugin;
