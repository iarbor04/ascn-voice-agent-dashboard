export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startApplicationMaintenance } = await import("./lib/maintenance.ts");
  await startApplicationMaintenance();
}
