import { useMemo } from "react";

import { apiUrl } from "@/api/client";

type ConsoleRichToken =
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; uri: string };

function resolveMediaUri(uri: string): string {
    const u = String(uri ?? "").trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("/")) return apiUrl(u);
    return apiUrl(`/${u}`);
}

function parseConsoleRichTokens(text: string): ConsoleRichToken[] {
    const input = String(text ?? "");
    if (!input) return [];

    const tokens: ConsoleRichToken[] = [];
    const re = /\[image\s+([^\s\]]+)(?:\s+([^\]]+))?\]/g;
    let lastIndex = 0;

    for (; ;) {
        const m = re.exec(input);
        if (!m) break;

        const start = m.index;
        if (start > lastIndex) {
            tokens.push({ type: "text", text: input.slice(lastIndex, start) });
        }

        const mimeType = String(m[1] ?? "").trim();
        const uri = String(m[2] ?? "").trim();
        if (mimeType && uri) {
            tokens.push({ type: "image", mimeType, uri });
        } else {
            tokens.push({ type: "text", text: m[0] });
        }

        lastIndex = re.lastIndex;
    }

    if (lastIndex < input.length) {
        tokens.push({ type: "text", text: input.slice(lastIndex) });
    }

    return tokens.length ? tokens : [{ type: "text", text: input }];
}

export function ConsoleRichContent(props: { text: string }) {
    const tokens = useMemo(() => parseConsoleRichTokens(props.text), [props.text]);
    if (!tokens.length) return null;

    return (
        <>
            {tokens.map((t, idx) => {
                if (t.type === "text") return <span key={`${idx}-t`}>{t.text}</span>;
                const src = resolveMediaUri(t.uri);
                if (!src) return <span key={`${idx}-b`}>{`[image ${t.mimeType}]`}</span>;
                return (
                    <a
                        key={`${idx}-i`}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "block", marginTop: 6 }}
                    >
                        <img
                            src={src}
                            alt={`image ${t.mimeType}`}
                            loading="lazy"
                            style={{
                                display: "block",
                                maxWidth: "100%",
                                maxHeight: 360,
                                borderRadius: 10,
                                border: "1px solid rgba(255,255,255,0.12)",
                            }}
                        />
                    </a>
                );
            })}
        </>
    );
}
