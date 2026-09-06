"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const INSTALLATION_PARAM = "installation_id";
const SETUP_ACTION_PARAM = "setup_action";

export default function GitHubAppInstallationLinker() {
  const didAttemptRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (typeof window === "undefined" || didAttemptRef.current || !supabase) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const installationId = Number(params.get(INSTALLATION_PARAM));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return;
    }

    didAttemptRef.current = true;

    const linkInstallation = async () => {
      setErrorMessage("");
      try {
        const {
          data: { session }
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error("Ariadne sign-in is required before linking the GitHub App.");
        }

        const { data, error } = await supabase.functions.invoke("github-sync", {
          body: {
            action: "link",
            installationId
          }
        });

        if (error) {
          throw error;
        }
        if (data?.error) {
          throw new Error(String(data.error));
        }

        params.delete(INSTALLATION_PARAM);
        params.delete(SETUP_ACTION_PARAM);
        const remainingQuery = params.toString();
        const cleanUrl = `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${window.location.hash || ""}`;
        window.history.replaceState({}, "", cleanUrl);

        // The backend has updated user_projects. Reload once so the existing
        // cloud hydration path reads the newly reconciled repository snapshot.
        window.location.reload();
      } catch (error) {
        didAttemptRef.current = false;
        setErrorMessage(
          error instanceof Error ? error.message : "GitHub App linking failed."
        );
      }
    };

    void linkInstallation();
  }, []);

  if (!errorMessage) {
    return null;
  }

  return (
    <div className="github-app-link-error" role="status">
      GitHub connection failed: {errorMessage}
    </div>
  );
}
