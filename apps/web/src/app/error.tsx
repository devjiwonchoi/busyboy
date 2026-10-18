"use client";

export default function AppError({ error }: { error: Error }) {
  return (
    <div id="boot-shell">
      <div id="boot-error" role="alert">
        <p>T3 Code could not load.</p>
        {process.env.NODE_ENV === "development" && <p>{error.message}</p>}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
