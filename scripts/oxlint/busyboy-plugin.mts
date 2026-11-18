// why: error.tsx and global-error.tsx are left out because Next requires them to be Client Components.
const SERVER_SEGMENT_FILE =
  /[\\/]app[\\/](?:.*[\\/])?(?:page|layout|template|default|loading|not-found|forbidden|unauthorized)\.[jt]sx?$/;

type Node = { type: string; directive?: string };
type Context = {
  filename: string;
  report: (descriptor: { node: Node; message: string }) => void;
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

export default {
  meta: { name: "busyboy" },
  rules: { "no-use-client-segment": noUseClientSegment },
};
