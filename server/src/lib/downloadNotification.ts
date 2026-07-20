export interface FinishedDownloadLabel {
  title: string;
  episode?: string;
  subtitle?: string;
  client: string;
}

/** Put the media identity first because phone notification UIs truncate both
 * lines aggressively. Boilerplate and the download client are lower priority. */
export function formatFinishedDownload(download: FinishedDownloadLabel): {
  title: string;
  body: string;
} {
  const title = [download.title, download.episode].filter(Boolean).join(" · ");
  const body = [download.subtitle, "Download finished", download.client]
    .filter(Boolean)
    .join(" · ");
  return { title: title || "Download finished", body };
}
