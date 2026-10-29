export default {
  async fetch(_request, env) {
    try {
      const upstream = await env.ANALYTICS.fetch(
        "https://analytics.phala.network/api/circulation",
        { method: "GET" },
      );
      const headers = new Headers();
      for (const name of ["Content-Type", "Cache-Control"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return new Response("Circulation temporarily unavailable", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;
