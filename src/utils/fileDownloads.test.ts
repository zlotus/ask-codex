import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFileCapability } from "./fileDownloads";

const CAPABILITY_ID = "abcdefghijklmnopqrstuvwxABCDEFGH";

describe("file downloads", () => {
  const createObjectURL = vi.fn(() => "blob:download");
  const revokeObjectURL = vi.fn();
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts only the opaque capability and saves the attachment filename", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response("report", {
      status: 200,
      headers: {
        "Content-Disposition": "attachment; filename=report.txt; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt",
        "Content-Length": "6",
        "Content-Type": "application/octet-stream",
      },
    }));

    await downloadFileCapability({
      href: "/workspace/private/report.txt:12",
      capabilityId: CAPABILITY_ID,
    }, "secret-token");

    expect(fetchMock).toHaveBeenCalledWith(`/api/file-downloads/${CAPABILITY_ID}`, {
      method: "POST",
      headers: {
        Accept: "application/octet-stream, application/json",
        Authorization: "Bearer secret-token",
      },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("workspace");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("secret-token");
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.instances[0]).toMatchObject({ download: "报告.txt" });
    expect(document.querySelector('a[href="blob:download"]')).not.toBeInTheDocument();

    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("rejects malformed capabilities without making a request", async () => {
    await expect(downloadFileCapability({
      href: "/workspace/report.txt",
      capabilityId: "../../report.txt",
    }, "token")).rejects.toThrow("File download is unavailable");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a fixed fallback filename for an unsafe disposition", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("data", {
      status: 200,
      headers: { "Content-Disposition": "inline; filename=../../secret.txt" },
    }));

    await downloadFileCapability({ href: "/workspace/file", capabilityId: CAPABILITY_ID }, "");

    expect(click.mock.instances[0]).toMatchObject({ download: "download" });
  });

  it("removes control and bidirectional formatting characters from filenames", async () => {
    const unsafeName = "\u0085report\u202Etxt.exe";
    vi.mocked(fetch).mockResolvedValue(new Response("data", {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(unsafeName)}`,
      },
    }));

    await downloadFileCapability({ href: "/workspace/file", capabilityId: CAPABILITY_ID }, "");

    expect(click.mock.instances[0]).toMatchObject({ download: "reporttxt.exe" });
  });

  it("surfaces fixed gateway errors and does not create a blob URL", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: { code: "fileDownloadNotFound", message: "File download is unavailable" },
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(downloadFileCapability({
      href: "/workspace/report.txt",
      capabilityId: CAPABILITY_ID,
    }, "token")).rejects.toThrow("File download is unavailable");

    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
