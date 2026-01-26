import { useTheme } from "../theme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="buttonSecondary" onClick={toggle} aria-label="切换主题">
      {theme === "dark" ? "浅色" : "深色"}
    </button>
  );
}

