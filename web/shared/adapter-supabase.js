/*!
 * chungnam-inline — web/shared/adapter-supabase.js
 *
 * Supabase 어댑터 — 껍데기. **아직 프로젝트도 자격증명도 없다.**
 * 이 파일은 어디에도 접속하지 않는다. supabase-js 클라이언트를 밖에서 주입받을 때만 동작한다.
 *
 *   const { createClient } = supabase;                       // CDN 전역
 *   const client = createClient(URL, ANON_KEY);
 *   const adapter = ChungnamSyncSupabaseAdapter.createSupabaseAdapter({ client, meetId });
 *
 * 서버 쪽이 맞춰야 할 계약(= adapter-memory.js 의 createMemoryServer 와 동일한 규칙):
 *
 *   rpc('sync_commit', { p_meet, p_events })  -> result[]
 *     p_events[i] = { id, meet_id, device_id, client_seq, scope, cell,
 *                     eid, heat, athlete_id, field, base_version,
 *                     old_value, new_value, at }
 *     result[i]   = { id, cell, status, version, value, device_id?, at?, reason? }
 *     status ∈ "applied" | "duplicate" | "conflict" | "rejected"
 *
 *   rpc('sync_pull', { p_meet, p_since })     -> { changes, cursor }
 *     또는 change_log 테이블 직접 조회 (아래 pullViaTable 참고)
 *     change = { log_seq, cell, scope, eid, heat, athlete_id, field,
 *                old_value, value, version, device_id, client_seq, at }
 *
 *   realtime: public.result_change_log 의 INSERT 를 meet_id 로 걸러 구독.
 *             payload.new 가 위 change 와 같은 모양이어야 한다.
 *
 * 권한: 심판 쓰기는 sync_commit 안에서 판정한다. anon 키만으로 write 가 되면 안 된다.
 *       클라이언트는 세션 토큰만 들고 있고, PIN 검증은 서버에서 한다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChungnamSyncSupabaseAdapter = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULTS = {
    commitRpc: "sync_commit",
    pullRpc: "sync_pull",
    changeTable: "result_change_log",
    channelPrefix: "meet:",
  };

  function createSupabaseAdapter(options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    var client = opts.client || null;
    var meetId = opts.meetId || null;
    var channel = null;
    var ctx = null;

    function need() {
      if (!client) throw new Error("adapter-supabase: supabase client 가 주입되지 않았습니다 (아직 프로젝트 없음)");
      return client;
    }

    function normalizeChange(row) {
      if (!row) return null;
      return {
        log_seq: row.log_seq,
        cell: row.cell,
        scope: row.scope,
        eid: row.eid,
        heat: row.heat,
        athlete_id: row.athlete_id,
        field: row.field,
        old_value: row.old_value,
        value: row.value === undefined ? row.new_value : row.value,
        version: row.version,
        device_id: row.device_id,
        client_seq: row.client_seq,
        at: row.at,
      };
    }

    return {
      name: "supabase",
      ready: !!client,

      connect: function (c) {
        ctx = c;
        meetId = meetId || c.meetId;
        var sb = need();
        channel = sb
          .channel(opts.channelPrefix + meetId)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: opts.changeTable, filter: "meet_id=eq." + meetId },
            function (payload) {
              var change = normalizeChange(payload && payload.new);
              if (change) ctx.onRemote([change]);
            }
          )
          .on("system", {}, function (p) {
            // 채널 상태를 상태 표시줄로 넘긴다
            ctx.onStatus({ connected: !p || p.status !== "closed" });
          });

        return new Promise(function (resolve) {
          channel.subscribe(function (status) {
            ctx.onStatus({ connected: status === "SUBSCRIBED" });
            if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
          });
        });
      },

      commit: function (events) {
        var sb = need();
        return sb
          .rpc(opts.commitRpc, { p_meet: meetId, p_events: events })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message || String(res.error));
            return res.data || [];
          });
      },

      pull: function (cursor) {
        var sb = need();
        if (opts.pullViaTable) {
          return sb
            .from(opts.changeTable)
            .select("*")
            .eq("meet_id", meetId)
            .gt("log_seq", cursor == null ? 0 : cursor)
            .order("log_seq", { ascending: true })
            .limit(opts.pullLimit || 2000)
            .then(function (res) {
              if (res.error) throw new Error(res.error.message || String(res.error));
              var rows = (res.data || []).map(normalizeChange);
              return { changes: rows, cursor: rows.length ? rows[rows.length - 1].log_seq : cursor };
            });
        }
        return sb.rpc(opts.pullRpc, { p_meet: meetId, p_since: cursor == null ? 0 : cursor }).then(function (res) {
          if (res.error) throw new Error(res.error.message || String(res.error));
          var data = res.data || {};
          return { changes: (data.changes || []).map(normalizeChange), cursor: data.cursor };
        });
      },

      disconnect: function () {
        if (channel && client) {
          try {
            client.removeChannel(channel);
          } catch (e) {}
        }
        channel = null;
        ctx = null;
        return Promise.resolve();
      },

      setClient: function (c) {
        client = c;
      },
    };
  }

  return { createSupabaseAdapter: createSupabaseAdapter, DEFAULTS: DEFAULTS };
});
