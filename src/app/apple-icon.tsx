import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(circle at 22% 18%, #2563eb 0%, #0b1220 48%, #070b15 100%)",
          borderRadius: 40,
          position: "relative",
        }}
      >
        <div
          style={{
            width: 104,
            height: 104,
            borderRadius: 999,
            border: "10px solid #f8fafc",
            position: "relative",
            boxShadow: "0 12px 28px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: 18,
              width: 6,
              height: 30,
              borderRadius: 999,
              background: "#f8fafc",
              transform: "translateX(-50%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 30,
              height: 6,
              borderRadius: 999,
              background: "#f8fafc",
              transform: "translate(-4px, -1px) rotate(30deg)",
            }}
          />
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
