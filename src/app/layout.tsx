import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/uncial-antiqua/400.css";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata = { title: "Revenant", description: "Investigate abandoned Node.js projects and verify a repair, using a local AI." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
