"use client";
import { useEffect, useRef } from "react";
import type { Health } from "@/lib/health-problems";

/** What this install is set up with, read from the running app. Closes on Escape or a click outside. */
export function SettingsDialog({ health, onClose }: { health: Health | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="dialog-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="dialog" onClick={(e) => e.stopPropagation()}>
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
          <button ref={closeRef} type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </div>
  );
}
