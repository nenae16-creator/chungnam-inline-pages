/*
 * 대회 실시간 서버 공통 설정.
 *
 * 이 파일은 정적 배포물에 포함되므로 service_role 키나 비밀번호를 넣지 않는다.
 * Supabase의 Project URL, 공개용 anon key, db/seed_chungnam.sql이 출력한 meet UUID만
 * 배포 환경에서 덮어쓴다. 값이 비어 있으면 모든 화면은 같은 기기 로컬 모드로 동작한다.
 */
(function (root) {
  "use strict";

  root.CHUNGNAM_LIVE_CONFIG = Object.assign(
    {
      meetId: "37f52c8a-9b3b-5837-bc6f-19ac02b75622",
      // Reserved non-deliverable address for the shared judge's Auth identity.
      // Password recovery is performed by the project owner, not email delivery.
      loginAliases: { admin: "admin@inline.invalid" },
      // Public-facing operator directory. Never place passwords or personal emails here.
      operatorAccounts: [
        { id: "admin", name: "공용 심판", role: "judge" },
      ],
      // 충남 대회용 Supabase 프로젝트가 아직 없다. 비워 두면 같은 기기·같은 브라우저 로컬 모드로 동작한다.
      supabaseUrl: "",
      supabaseAnonKey: "",
    },
    root.CHUNGNAM_LIVE_CONFIG || {}
  );
})(typeof globalThis !== "undefined" ? globalThis : window);
