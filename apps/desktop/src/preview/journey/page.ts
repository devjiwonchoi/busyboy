// @ts-nocheck - React is resolved from apps/web when the journey test bundles this page.
// A small React app for the preview isolation journey test (PreviewIsolation.journey.test.ts).
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    "button",
    { type: "button", onClick: () => setCount((value) => value + 1) },
    `Count: ${count}`,
  );
}

function App() {
  return createElement(
    "main",
    null,
    createElement("h1", null, "Preview journey"),
    createElement(Counter),
  );
}

createRoot(document.getElementById("root")!).render(createElement(App));
