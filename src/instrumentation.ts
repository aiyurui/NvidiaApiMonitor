export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/lib/scheduler");
    console.info("[instrumentation] starting scheduler…");
    await startScheduler()
      .then(() => console.info("[instrumentation] scheduler activated"))
      .catch((e) => console.error("[scheduler] start failed", e));
  }
}
