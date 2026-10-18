import { transform } from "oxc-transform-react";

// Reuse Vite's compiler while leaving JSX and Fast Refresh to Next's SWC loader.
export default function reactCompilerLoader(source) {
  const callback = this.async();
  transform(this.resourcePath, source, {
    jsx: "preserve",
    reactCompiler: {},
    sourcemap: true,
  }).then(
    (result) => {
      if (result.fatal) {
        callback(new Error(result.errors.map((error) => error.message).join("\n")));
        return;
      }
      for (const diagnostic of result.errors) {
        this.emitWarning(new Error(diagnostic.message));
      }
      callback(null, result.code, result.map);
    },
    (error) => callback(error),
  );
}
