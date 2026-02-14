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
          background: "#121212",
          color: "#EAEAEA",
          fontSize: 120,
          fontWeight: 800,
          borderRadius: 96,
          letterSpacing: -2,
        }}
      >
        TT
      </div>
    ),
    {
      ...size,
    }
  );
}
