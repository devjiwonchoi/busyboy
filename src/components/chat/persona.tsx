import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type Persona = { name: string; mark?: string; imageUrl?: string; tone?: string };

// Full class strings so Tailwind can see them.
const LETTER_TONES = [
  "bg-gradient-to-br from-fuchsia-400 to-violet-500 text-white",
  "bg-teal-400 text-white",
  "bg-orange-400 text-white",
  "bg-sky-400 text-white",
  "bg-rose-400 text-white",
  "bg-amber-400 text-white",
];

function hashName(name: string) {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash;
}

export function letterOf(name: string) {
  const first = [...name.trim()][0] ?? "?";
  return first.toLocaleUpperCase();
}

export function letterTone(name: string) {
  return LETTER_TONES[hashName(name.trim() || "Manager") % LETTER_TONES.length];
}

export function managerPersona(name: string): Persona {
  return { name, mark: letterOf(name), tone: letterTone(name) };
}

export function LetterMark({ name, className }: { name: string; className?: string }) {
  const letter = letterOf(name);
  return (
    <span
      data-letter={letter}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
        letterTone(name),
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function LetterStack({ names, className }: { names: string[]; className?: string }) {
  const marks = names.slice(0, 2);
  return (
    <span className={cn("relative size-10 shrink-0", className)}>
      {marks.map((name, index) => (
        <LetterMark
          key={`${name}-${index}`}
          name={name}
          className={cn(
            "absolute size-6 text-[11px] ring-2 ring-background dark:ring-[#161617]",
            index === 0 ? "top-0 left-0" : "right-0 bottom-0 z-10",
          )}
        />
      ))}
    </span>
  );
}

export function PersonaAvatar({ persona, className }: { persona: Persona; className?: string }) {
  return (
    <Avatar aria-hidden data-emoji={persona.mark} className={cn("size-8 text-base", className)}>
      {persona.imageUrl && <AvatarImage src={persona.imageUrl} alt="" />}
      <AvatarFallback className={persona.tone}>{persona.mark}</AvatarFallback>
    </Avatar>
  );
}
