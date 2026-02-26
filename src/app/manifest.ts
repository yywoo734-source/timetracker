import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PainTracker",
    short_name: "PainTracker",
    description: "고통 기록과 자기성찰로 성장하는 앱",
    start_url: "/new-app",
    display: "standalone",
    background_color: "#121212",
    theme_color: "#121212",
    lang: "ko",
    icons: [
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
