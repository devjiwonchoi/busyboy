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

const testsDirectory = "tests";
const testHelpersFolder = "utils";
const e2eTestFile = /\.e2e\.ts$/;

function testLayoutProblem(path: string) {
  if (!path.startsWith(testsDirectory + sep)) return undefined;
  const parts = relative(testsDirectory, path).split(sep);
  const isTest = e2eTestFile.test(path);
  if (parts.length === 1 && isTest) return undefined;
  if (parts.length === 1)
    return "Only *.e2e.ts tests sit in tests. Move shared code to tests/utils.";
  if (parts.length === 2 && parts[0] === testHelpersFolder && !isTest) return undefined;
  if (parts.length === 2 && parts[0] === testHelpersFolder)
    return "tests/utils holds shared code only. Move the test up to tests.";
  return "Keep tests flat: tests directly in it, shared code directly in tests/utils.";
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

const flatTests = {
  meta: { type: "problem" },
  create(context: Context) {
    const path = repositoryPath(context);
    if (!path.startsWith(testsDirectory + sep)) return {};
    return {
      Program(program: Node) {
        const message = testLayoutProblem(path);
        if (message) context.report({ node: program, message });
      },
      CallExpression(node: Node) {
        if (isTestExtend(node.callee as Node))
          context.report({
            node,
            message:
              "Write e2e setup inline or in a beforeEach and share it from tests/utils, not as a test.extend fixture.",
          });
      },
    };
  },
};

const allowedTestImports = new Map([
  ["@e2e-dev/web", new Set(["describe", "test", "beforeEach"])],
  ["e2e", new Set(["expect"])],
]);
const testHelperImport = /^\.\/utils\/[a-z0-9-]+$/;
const allowedFixtures = new Set(["app", "agent", "screen"]);
const reservedTestNames = new Set([...allowedFixtures, "expect"]);
const locatorQueries = new Set([
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByDisplayValue",
]);
const locatorNarrowers = new Set(["filter", "first", "last", "nth"]);
const locatorMatchers = new Set([
  "toBeVisible",
  "toBeHidden",
  "toBeEnabled",
  "toBeDisabled",
  "toBeChecked",
  "toBeFocused",
  "toBeAttached",
  "toHaveText",
  "toContainText",
  "toHaveValue",
  "toHaveAttribute",
  "toHaveCount",
  "toHaveAccessibleName",
  "toBeExpanded",
  "toBeSelected",
]);
const agentJudgments = new Set(["assert", "waitFor", "extract"]);

const allowedTestSyntax =
  'e2e tests allow only app.open("<path>"), agent.act("<goal>", { params }), expect(screen.getBy…(…)).<locator matcher>(…), and tests/utils helpers, with literal arguments, inside describe, beforeEach, and test.';
const driveWithAgent =
  'Drive the UI with agent.act("<goal>") and check the result with expect(screen.getBy…(…)). Locator actions and waits are not allowed in e2e tests.';
const checkWithLocator =
  "Check results with expect(screen.getBy…(…)).<locator matcher>(…). agent.assert, agent.waitFor, and agent.extract call the model on every run.";

type Problem = { node: Node; message: string };

function identifierName(node: Node | undefined) {
  return node?.type === "Identifier" ? (node.name as string) : undefined;
}

function memberCall(node: Node) {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee as Node;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  return {
    object: callee.object as Node,
    name: identifierName(callee.property as Node),
    args: node.arguments as Node[],
  };
}

function isLiteralValue(node: Node): boolean {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return (node.expressions as Node[]).length === 0;
  if (node.type === "ArrayExpression")
    return (node.elements as (Node | null)[]).every(
      (element) => element && isLiteralValue(element),
    );
  if (node.type !== "ObjectExpression") return false;
  return (node.properties as Node[]).every(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      property.kind === "init" &&
      !property.method &&
      isLiteralValue(property.value as Node),
  );
}

function isStringLiteral(node: Node | undefined) {
  if (node?.type === "Literal") return typeof node.value === "string";
  return node?.type === "TemplateLiteral" && (node.expressions as Node[]).length === 0;
}

function isActOptions(node: Node | undefined) {
  if (!node) return true;
  if (node.type !== "ObjectExpression") return false;
  return (node.properties as Node[]).every(
    (property) => property.type === "Property" && identifierName(property.key as Node) === "params",
  );
}

function isLocator(node: Node): boolean {
  const call = memberCall(node);
  if (!call?.name || !call.args.every(isLiteralValue)) return false;
  if (locatorQueries.has(call.name)) return identifierName(call.object) === "screen";
  return locatorNarrowers.has(call.name) && isLocator(call.object);
}

function isExpectOfLocator(node: Node): boolean {
  if (node.type === "MemberExpression" && identifierName(node.property as Node) === "not")
    return isExpectOfLocator(node.object as Node);
  if (node.type !== "CallExpression" || identifierName(node.callee as Node) !== "expect")
    return false;
  const [subject, ...rest] = node.arguments as Node[];
  return Boolean(subject) && rest.length === 0 && isLocator(subject);
}

function stepProblem(expression: Node, helpers: Set<string>): string | undefined {
  const call = expression.type === "AwaitExpression" ? (expression.argument as Node) : expression;
  if (call.type !== "CallExpression") return allowedTestSyntax;
  const args = call.arguments as Node[];
  if (!args.every(isLiteralValue)) return allowedTestSyntax;

  const helper = identifierName(call.callee as Node);
  if (helper) return helpers.has(helper) ? undefined : allowedTestSyntax;
  if (expression.type !== "AwaitExpression") return allowedTestSyntax;

  const member = memberCall(call);
  const owner = member && identifierName(member.object);
  if (owner === "app" && member?.name === "open" && args.length === 1 && isStringLiteral(args[0]))
    return undefined;
  if (
    owner === "agent" &&
    member?.name === "act" &&
    args.length <= 2 &&
    isStringLiteral(args[0]) &&
    isActOptions(args[1])
  )
    return undefined;
  if (owner === "agent" && member?.name && agentJudgments.has(member.name)) return checkWithLocator;
  if (member?.name && locatorMatchers.has(member.name) && isExpectOfLocator(member.object))
    return undefined;
  if (member && (isLocator(member.object) || owner === "screen" || owner === "browser"))
    return driveWithAgent;
  return allowedTestSyntax;
}

function callbackProblems(
  call: Node,
  callback: Node | undefined,
  helpers: Set<string>,
  problems: Problem[],
) {
  if (
    callback?.type !== "ArrowFunctionExpression" ||
    (callback.body as Node).type !== "BlockStatement"
  ) {
    problems.push({ node: callback ?? call, message: allowedTestSyntax });
    return;
  }
  const [fixtures, ...extra] = callback.params as Node[];
  const fixturesAllowed =
    !fixtures ||
    (fixtures.type === "ObjectPattern" &&
      (fixtures.properties as Node[]).every(
        (property) =>
          property.type === "Property" &&
          property.shorthand &&
          (property.value as Node).type === "Identifier" &&
          allowedFixtures.has(identifierName(property.key as Node) ?? ""),
      ));
  if (!fixturesAllowed || extra.length)
    problems.push({ node: callback, message: allowedTestSyntax });

  for (const statement of (callback.body as Node).body as Node[]) {
    const message =
      statement.type === "ExpressionStatement"
        ? stepProblem(statement.expression as Node, helpers)
        : allowedTestSyntax;
    if (message) problems.push({ node: statement, message });
  }
}

function blockProblems(
  statement: Node,
  allowed: Set<string>,
  helpers: Set<string>,
  problems: Problem[],
) {
  const call =
    statement.type === "ExpressionStatement" ? (statement.expression as Node) : undefined;
  const name = call?.type === "CallExpression" ? identifierName(call.callee as Node) : undefined;
  if (!call || !name || !allowed.has(name)) {
    problems.push({ node: statement, message: allowedTestSyntax });
    return;
  }
  const args = call.arguments as Node[];
  const [title, body] = name === "beforeEach" ? [undefined, args[0]] : args;
  const titleAllowed =
    name === "beforeEach" ? args.length === 1 : args.length === 2 && isStringLiteral(title);
  if (!titleAllowed) problems.push({ node: call, message: allowedTestSyntax });

  if (name !== "describe") {
    callbackProblems(call, body, helpers, problems);
    return;
  }
  if (
    body?.type !== "ArrowFunctionExpression" ||
    (body.params as Node[]).length ||
    (body.body as Node).type !== "BlockStatement"
  ) {
    problems.push({ node: call, message: allowedTestSyntax });
    return;
  }
  for (const inner of (body.body as Node).body as Node[])
    blockProblems(inner, new Set(["beforeEach", "test"]), helpers, problems);
}

function importProblem(statement: Node, helpers: Set<string>) {
  const source = (statement.source as Node).value as string;
  const specifiers = statement.specifiers as Node[];
  const named = specifiers.every(
    (specifier) =>
      specifier.type === "ImportSpecifier" &&
      specifier.importKind !== "type" &&
      identifierName(specifier.imported as Node) === identifierName(specifier.local as Node),
  );
  if (statement.importKind === "type" || !named || !specifiers.length) return true;

  const names = specifiers.map((specifier) => identifierName(specifier.local as Node) ?? "");
  if (testHelperImport.test(source)) {
    if (names.some((name) => reservedTestNames.has(name))) return true;
    for (const name of names) helpers.add(name);
    return false;
  }
  const allowed = allowedTestImports.get(source);
  return !allowed || !names.every((name) => allowed.has(name));
}

const agenticTests = {
  meta: { type: "problem" },
  create(context: Context) {
    const path = repositoryPath(context);
    if (!path.startsWith(testsDirectory + sep) || !e2eTestFile.test(path)) return {};
    return {
      Program(program: Node) {
        const helpers = new Set<string>();
        const problems: Problem[] = [];
        const statements = program.body as Node[];
        for (const statement of statements) {
          if (statement.type === "ImportDeclaration" && importProblem(statement, helpers))
            problems.push({ node: statement, message: allowedTestSyntax });
        }
        for (const statement of statements) {
          if (statement.type !== "ImportDeclaration")
            blockProblems(statement, new Set(["describe"]), helpers, problems);
        }
        for (const problem of problems) context.report(problem);
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
    "flat-tests": flatTests,
    "agentic-tests": agenticTests,
  },
};

export default busyboyPlugin;
