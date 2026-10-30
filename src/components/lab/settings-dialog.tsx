"use client";
import { useEffect, useRef } from "react";
import type { Health } from "@/lib/health-problems";

/** What this install is set up with, read from the running app. Closes on Escape or a click outside. */
export function SettingsDialog({ health, onClose }: { health: Health | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose; // the effect below runs once, so it reads the latest callback through this ref
  });
  // showModal() makes the page behind inert, keeps Tab inside, closes on Escape and returns focus to the Settings button
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const onCloseEvent = () => closeRef.current();
    dialog.addEventListener("close", onCloseEvent);
    return () => {
      dialog.removeEventListener("close", onCloseEvent);
      opener?.focus(); // the dialog is removed from the page, so give focus back by hand
    };
  }, []);

  const rows: [string, string][] = health
    ? [
        ["Model", health.ollama.model],
        ["Model status", !health.ollama.reachable ? "Ollama is not running" : health.ollama.modelInstalled ? "Ready" : "Not installed"],
        ["Sandbox image", health.docker.image],
        ["Docker", !health.docker.available ? "Not available" : health.docker.imagePresent ? "Ready" : "Image not installed"],
        ...(health.limits ? ([["Upload limit", `${health.limits.maxArchiveMb} MB`], ["Project limit", `${health.limits.maxProjectMb} MB`]] as [string, string][]) : []),
      ]
    : [["Status", "Checking…"]];

  return (
    <dialog ref={ref} aria-labelledby="settings-title" className="dialog" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex flex-col gap-3 p-4">
        <h2 id="settings-title" className="dialog-title m-0">Settings</h2>
        <dl className="dialog-body m-0 flex flex-col">
          {rows.map(([name, value]) => (
            <div key={name} className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-muted">{name}</dt>
              <dd className="m-0 break-all text-right font-mono text-fg">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-xs text-muted">These are set when Revenant is launched (see .env.local). To change them, edit that file and restart.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </dialog>
  );
}
