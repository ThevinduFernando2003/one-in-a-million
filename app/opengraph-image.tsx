import { ImageResponse } from "next/og";

/**
 * Static, generic share image, generated once at build time. It deliberately
 * contains no live number: previews must never imply that anyone holds a
 * specific number, and they must never trigger an allocation.
 */
export const alt = "One in a Million: every visitor gets a unique number";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: "linear-gradient(135deg, #0b0c10 0%, #1e1b4b 60%, #3b2a05 100%)",
        color: "#f5f5f4",
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -0.5 }}>One in a Million</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
        <div style={{ fontSize: 220, fontWeight: 800, letterSpacing: -8, color: "#fcd34d" }}>
          #?
        </div>
        <div style={{ fontSize: 44, color: "#d6d3d1", maxWidth: 640 }}>
          Every visitor gets a unique number. What&apos;s yours?
        </div>
      </div>
      <div style={{ fontSize: 28, color: "#a8a29e" }}>
        1 to 1,000,000 · first come, first served
      </div>
    </div>,
    size,
  );
}
