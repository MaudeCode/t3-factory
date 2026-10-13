// Fetch wrapper shared by every request. Reads retry one transient proxy failure; writes never do,
// because a lost dispatch is reconciled through its saved request ID instead.
export const api = Object.assign(
  async function api(path, options = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data !== null) return data;
      if (
        attempt === 0 &&
        (options.method || "GET").toUpperCase() === "GET" &&
        [502, 503, 504].includes(response.status)
      )
        continue;
      if (response.status === 401) api.onUnauthorized();
      const error = new Error(
        data?.message ||
          data?.reason ||
          (response.ok
            ? "Factory returned an empty or invalid response. Check request status before retrying."
            : `Factory request failed (HTTP ${response.status}).`),
      );
      error.status = response.status;
      throw error;
    }
  },
  { onUnauthorized: () => {} },
);

export const post = (path, body, headers) =>
  api(path, { method: "POST", body: JSON.stringify(body), headers });
