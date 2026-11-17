"use client";

import { useState } from "react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";

import { useExternalSync } from "@/hooks/use-external-sync";

// why: Mermaid is large and only needed once a fence is on screen, so the browser
// why: loads it on demand. A failed import can be tried again the next time.
let mermaidModule: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  mermaidModule ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidModule = null;
      throw error;
    });
  return mermaidModule;
}

// why: initialize() is global, and render() writes a temporary node, so one diagram
// why: finishes before the next starts.
let renderQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>) {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// why: getComputedStyle returns lab() for an oklch token, and Mermaid rejects that.
function tokenColor(name: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return "#888888";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  const channel = (value: number) => value.toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

let nextDiagram = 0;

// why: Mermaid's defaults are a light cream diagram. Labels stay SVG text so the result is the diagram.
async function drawDiagram(source: string, dark: boolean) {
  const text = source.trim();
  if (!text) throw new Error("The diagram is empty.");
  const id = `mermaid${(nextDiagram += 1)}`;
  const mermaid = await loadMermaid();
  const foreground = tokenColor("--foreground");
  const muted = tokenColor("--muted-foreground");
  const surface = tokenColor("--secondary");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // why: Keep the site theme. A diagram directive must not replace it.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "theme",
      "themeVariables",
      "themeCSS",
      "htmlLabels",
      "flowchart",
    ],
    fontFamily: getComputedStyle(document.body).fontFamily,
    theme: "base",
    themeVariables: {
      darkMode: dark,
      background: tokenColor("--popover"),
      fontFamily: getComputedStyle(document.body).fontFamily,
      primaryColor: surface,
      primaryTextColor: foreground,
      primaryBorderColor: muted,
      secondaryColor: surface,
      tertiaryColor: tokenColor("--muted"),
      lineColor: muted,
      textColor: foreground,
    },
  });
  try {
    await mermaid.parse(text);
    // why: bindFunctions would attach click handlers to nodes. The diagram is a picture.
    const { svg } = await mermaid.render(id, text);
    if (!/<svg[\s>]/i.test(svg)) throw new Error("Mermaid did not return a diagram.");
    return svg;
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/*why: * The fence as Streamdown already shows every other code block. */
function MermaidSource({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  return (
    <div data-mermaid="code">
      <CodeBlock code={code} language="mermaid" isIncomplete={isIncomplete} lineNumbers>
        <CodeBlockCopyButton code={code} />
      </CodeBlock>
    </div>
  );
}

export function MermaidBlock({ code, isIncomplete }: CustomRendererProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useExternalSync(() => {
    if (isIncomplete) return;
    let active = true;
    let drawnDark: boolean | null = null;
    const root = document.documentElement;

    const draw = () => {
      const dark = root.classList.contains("dark");
      if (dark === drawnDark) return;
      drawnDark = dark;
      void enqueue(() => drawDiagram(code, dark)).then(
        (next) => {
          if (active && drawnDark === dark) {
            setFailed(false);
            setSvg(next);
          }
        },
        () => {
          if (active && drawnDark === dark) setFailed(true);
        },
      );
    };

    draw();
    const observer = new MutationObserver(draw);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [code, isIncomplete]);

  if (isIncomplete || failed) return <MermaidSource code={code} isIncomplete={isIncomplete} />;
  if (!svg) return null;
  return (
    <div
      data-mermaid="diagram"
      className="my-2 overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // why: Mermaid returns the SVG for this fence. securityLevel "strict" sanitizes it.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
