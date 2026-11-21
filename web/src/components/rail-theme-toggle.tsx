import { Moon, Sun } from "lucide-react";
import { setThemePreference } from "@/lib/theme";
import { useThemeType } from "@/lib/use-theme-type";

/**
 * P6a (21-11-2026): directe 1-klik Licht/Donker-schakelaar in de zijbalkvoet.
 */
export function RailThemeToggle({ compact }: { compact?: boolean }) {
  const dark = useThemeType() === "dark";
  return (
    <button
      type="button"
      onClick={() => setThemePreference(!dark)}
      aria-label={dark ? "Schakel naar lichte modus" : "Schakel naar donkere modus"}
      title={dark ? "Lichte modus" : "Donkere modus"}
      className={
        compact
          ? "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          : "ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      }
    >
      {dark ? <Sun className="size-3.5" aria-hidden="true" /> : <Moon className="size-3.5" aria-hidden="true" />}
    </button>
  );
}
