import type { GraphNode } from "@t3tools/contracts";
import { nodeEndState } from "@t3tools/shared/one-chat";
import type { ReactNode } from "react";

import { LargeDialog } from "./large-dialog";

function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section data-one-chat-modal-section={name} className="flex flex-col gap-1.5 py-2 text-sm">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A node graph item's agreed end state: purpose, criteria, what not to do, and files. */
export function NodeEndStateModal({
  node,
  onOpenChange,
}: {
  node: GraphNode | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (node === null) return null;
  const end = nodeEndState(node);
  return (
    <LargeDialog open onOpenChange={onOpenChange} title={end.title} name="end-state">
      <Section name="purpose" title="Purpose">
        <p className="whitespace-pre-wrap">{end.purpose ?? "Not written yet"}</p>
      </Section>
      <Section name="criteria" title="Success criteria and checks">
        {end.criteria.length === 0 ? (
          <p className="text-muted-foreground">None yet</p>
        ) : (
          <ol className="list-decimal ps-5">
            {end.criteria.map((criterion) => (
              <li key={criterion.id} data-status={criterion.status}>
                {criterion.text}
                <span className="text-muted-foreground">
                  {criterion.how ? ` · ${criterion.how}` : ""} · {criterion.status}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section name="non-goals" title="Do not">
        {end.dont.length === 0 ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <ul className="list-disc ps-5">
            {end.dont.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section name="files" title="File tree">
        {end.expectedFiles.length === 0 ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {end.expectedFiles.map((file) => (
              <li key={file.path}>
                {file.change ? <span className="text-muted-foreground">{file.change} </span> : null}
                {file.path}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {end.issues.length > 0 ? (
        <Section name="issues" title="Issues">
          <ul className="list-disc ps-5 text-destructive-foreground">
            {end.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </LargeDialog>
  );
}
