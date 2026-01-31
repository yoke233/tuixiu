import { useTheme } from "../theme";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ThemeToggle() {
  const { theme, setTheme, accent, setAccent } = useTheme();
  const resolvedTheme =
    theme === "system"
      ? document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : theme;
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setTheme(nextTheme)}
        aria-label="切换主题"
      >
        {resolvedTheme === "dark" ? "浅色" : "深色"}
      </Button>

      <Select value={accent} onValueChange={(v) => setAccent(v as any)}>
        <SelectTrigger aria-label="选择配色" className="h-9 w-[140px]">
          <SelectValue placeholder="配色" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="teal">青绿</SelectItem>
          <SelectItem value="cyan">青蓝</SelectItem>
          <SelectItem value="blue">深蓝</SelectItem>
          <SelectItem value="indigo">靛蓝</SelectItem>
          <SelectItem value="violet">紫罗兰</SelectItem>
          <SelectItem value="fuchsia">洋红</SelectItem>
          <SelectItem value="rose">玫红</SelectItem>
          <SelectItem value="orange">橙</SelectItem>
          <SelectItem value="amber">琥珀</SelectItem>
          <SelectItem value="emerald">翡翠</SelectItem>
          <SelectItem value="slate">石墨</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
