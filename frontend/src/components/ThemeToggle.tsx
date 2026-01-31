import { useTheme } from "../theme";

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
    <button
      type="button"
      className="buttonSecondary"
      onClick={() => setTheme(nextTheme)}
      aria-label="切换主题"
    >
      {resolvedTheme === "dark" ? "浅色" : "深色"}
    </button>
  );
}
