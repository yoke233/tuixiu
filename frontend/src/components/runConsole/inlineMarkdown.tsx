import type { ReactNode } from "react";

export function splitFirstLine(text: string): { firstLine: string; rest: string } {
    const input = String(text ?? "");
    if (!input) return { firstLine: "", rest: "" };
    const lf = input.indexOf("\n");
    if (lf === -1) return { firstLine: input.replace(/\r$/, ""), rest: "" };
    return { firstLine: input.slice(0, lf).replace(/\r$/, ""), rest: input.slice(lf + 1) };
}

export function renderInlineMarkdown(text: string): ReactNode {
    const input = String(text ?? "");
    if (!input) return null;

    const nodes: ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < input.length) {
        const nextBold = input.indexOf("**", i);
        const nextCode = input.indexOf("`", i);
        const next = Math.min(
            nextBold === -1 ? Number.POSITIVE_INFINITY : nextBold,
            nextCode === -1 ? Number.POSITIVE_INFINITY : nextCode,
        );

        if (next === Number.POSITIVE_INFINITY) {
            nodes.push(<span key={`t-${key++}`}>{input.slice(i)}</span>);
            break;
        }

        if (next > i) {
            nodes.push(<span key={`t-${key++}`}>{input.slice(i, next)}</span>);
            i = next;
        }

        if (input.startsWith("**", i)) {
            const end = input.indexOf("**", i + 2);
            if (end === -1) {
                nodes.push(<span key={`t-${key++}`}>{"**"}</span>);
                i += 2;
                continue;
            }
            nodes.push(<strong key={`b-${key++}`}>{input.slice(i + 2, end)}</strong>);
            i = end + 2;
            continue;
        }

        if (input[i] === "`") {
            const end = input.indexOf("`", i + 1);
            if (end === -1) {
                nodes.push(<span key={`t-${key++}`}>{"`"}</span>);
                i += 1;
                continue;
            }
            nodes.push(<code key={`c-${key++}`}>{input.slice(i + 1, end)}</code>);
            i = end + 1;
            continue;
        }

        nodes.push(<span key={`t-${key++}`}>{input[i]}</span>);
        i += 1;
    }

    return <>{nodes}</>;
}
