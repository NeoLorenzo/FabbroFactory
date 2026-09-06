"use client";

import { useEffect } from "react";

export default function CodingCompatibilityPage() {
  useEffect(() => {
    const basePath = String(process.env.NEXT_PUBLIC_BASE_PATH || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const query = window.location.search || "";
    window.location.replace(`${basePath ? `/${basePath}` : ""}/${query}`);
  }, []);

  return null;
}
