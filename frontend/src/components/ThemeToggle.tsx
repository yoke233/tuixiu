import { useTheme } from "../theme";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const resolvedTheme =
    theme === "system"
      ? document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : theme;
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setTheme(nextTheme)}
      aria-label="切换主题"
    >
      {resolvedTheme === "dark" ? "浅色" : "深色"}
    </Button>
  );
}
