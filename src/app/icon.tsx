import { ImageResponse } from "next/og";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default function Icon() {
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
            "radial-gradient(circle at 20% 15%, #1d4ed8 0%, #0b1220 45%, #070b15 100%)",
          borderRadius: 108,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -80,
            right: -40,
            width: 260,
            height: 260,
            borderRadius: 999,
            background: "rgba(255,255,255,0.14)",
            filter: "blur(6px)",
          }}
        />
        <div
          style={{
            width: 280,
            height: 280,
            borderRadius: 999,
            border: "22px solid #f8fafc",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 18,
              height: 92,
              borderRadius: 999,
              background: "#f8fafc",
              transform: "translateY(-18px)",
            }}
          />
          <div
            style={{
              position: "absolute",
              width: 80,
              height: 14,
              borderRadius: 999,
              background: "#f8fafc",
              transform: "translateX(28px) translateY(12px) rotate(32deg)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 36,
              fontSize: 46,
              fontWeight: 800,
              color: "#dbeafe",
              letterSpacing: -1,
            }}
          >
            Time
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
