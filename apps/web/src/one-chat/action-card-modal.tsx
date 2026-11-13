import type { EnvironmentId, ProjectTaskSpec } from "@t3tools/contracts";
import type { ActionCard, ActionCardOption } from "@t3tools/shared/one-chat";
import type { ReactNode } from "react";

import { OptionButtons, useCurrentSpec } from "./action-card";
import { LargeDialog } from "./large-dialog";

function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section data-one-chat-modal-section={name} className="flex flex-col gap-1.5 py-2">
      <h3 className="font-semibold text-sm">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function Paragraphs({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1.5 whitespace-pre-wrap wrap-break-word">
      {text
        .split(/\n\s*\n/)
        .filter((part) => part.trim().length > 0)
        .map((part, index) => (
          <p key={index}>{part.trim()}</p>
        ))}
    </div>
  );
}

function RulesSection({ card, title = "Rules" }: { card: ActionCard; title?: string }) {
  if (card.details.length === 0) return null;
  return (
    <Section name="rules" title={title}>
      <dl className="flex flex-col gap-1">
        {card.details.map((detail, index) => (
          <div key={index}>
            <dt className="text-muted-foreground text-xs">{detail.label}</dt>
            <dd className="whitespace-pre-wrap">{detail.text}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PlanSections({ card, spec }: { card: ActionCard; spec: ProjectTaskSpec | null }) {
  const purpose = card.goal ?? spec?.summary ?? spec?.goal ?? "";
  return (
    <>
      <Section name="purpose" title="Purpose">
        <Paragraphs text={purpose || card.question} />
      </Section>
      <Section name="criteria" title="Success criteria and checks">
        {spec && spec.criteria.length > 0 ? (
          <ol className="list-decimal ps-5">
            {spec.criteria.map((criterion) => (
              <li key={criterion.id}>
                {criterion.text}
                {criterion.provenBy ? (
                  <span className="text-muted-foreground"> · {criterion.provenBy}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : card.criteria.length > 0 ? (
          <ol className="list-decimal ps-5">
            {card.criteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ol>
        ) : (
          <Paragraphs text={spec?.successCriteria || card.verification || "None yet"} />
        )}
      </Section>
      <Section name="non-goals" title="Do not">
        <Paragraphs text={spec?.nonGoals || "None"} />
      </Section>
      {spec?.flow ? (
        <Section name="flow" title="Flow">
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {spec.flow}
          </pre>
        </Section>
      ) : null}
      {spec?.prototype ? (
        <Section name="mockup" title="Mockup">
          <iframe
            title="Mockup"
            sandbox=""
            srcDoc={spec.prototype}
            className="h-80 w-full rounded-md border bg-white"
          />
        </Section>
      ) : null}
      {spec && spec.files.length > 0 ? (
        <Section name="files" title="File tree">
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {spec.files.map((file) => (
              <li key={file.path}>
                <span className="text-muted-foreground">{file.change}</span> {file.path}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <RulesSection card={card} />
    </>
  );
}

function PlanBody({ card, environmentId }: { card: ActionCard; environmentId: EnvironmentId }) {
  const spec = useCurrentSpec(environmentId, card.projectId, card.taskId!);
  return <PlanSections card={card} spec={spec} />;
}

/** "Details": the whole card, with the choices again at the bottom. */
export function ActionCardModal({
  card,
  environmentId,
  onOpenChange,
  onPick,
}: {
  card: ActionCard | null;
  environmentId: EnvironmentId | null;
  onOpenChange: (open: boolean) => void;
  onPick: (card: ActionCard, option: ActionCardOption) => void;
}) {
  if (card === null) return null;
  const isPlan = card.kind === "plan";
  return (
    <LargeDialog
      open
      onOpenChange={onOpenChange}
      title={card.question}
      name="card"
      footer={
        card.answered ? (
          <p className="text-muted-foreground text-sm">You chose: {card.answered.label}</p>
        ) : (
          <OptionButtons
            card={card}
            onPick={(option) => {
              onOpenChange(false);
              onPick(card, option);
            }}
          />
        )
      }
    >
      <p className="pb-1 text-muted-foreground text-xs">
        {[card.projectName, card.taskTitle].filter(Boolean).join(" · ")}
      </p>
      {isPlan && card.taskId !== null && environmentId !== null ? (
        <PlanBody card={card} environmentId={environmentId} />
      ) : isPlan ? (
        <PlanSections card={card} spec={null} />
      ) : (
        <>
          <Section name="question" title="Question">
            <Paragraphs text={[card.question, ...card.detailParagraphs].join("\n\n")} />
          </Section>
          <RulesSection card={card} title="Details" />
        </>
      )}
    </LargeDialog>
  );
}
