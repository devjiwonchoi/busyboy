import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Node = { type: string; [key: string]: unknown };
type Context = {
  filename: string;
  report(descriptor: { node: Node; message: string }): void;
};

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
        if (!component && !route && !isUseServer(program)) return;
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
      },
    };
  },
};

const plugin = {
  meta: { name: "busyboy" },
  rules: { "no-proxy": noProxy, "trusted-entry": trustedEntry },
};

export default plugin;
