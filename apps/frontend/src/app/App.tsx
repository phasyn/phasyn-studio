import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState } from "react";
import { RouterProvider } from "react-router";
import { motionTransition } from "@/components/ui/motion";
import { createQueryClient } from "./queryClient";
import { createAppRouter } from "./routes";
import "./document.css";

// Motion components default to the smooth spring from the index.css tokens; motion is always on, whatever the OS's
// reduced-motion setting says (reducedMotion="never").
export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  const [transition] = useState(() => motionTransition("spring-smooth", "spring-smooth"));
  return (
    <MotionConfig reducedMotion="never" transition={transition}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MotionConfig>
  );
}
