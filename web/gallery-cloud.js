(function(root) {
  let client;
  function connection() {
    const c = root.CHUNGNAM_LIVE_CONFIG || {};
    if (!c.supabaseUrl || !c.supabaseAnonKey || !c.meetId || !root.supabase)
      throw new Error('온라인 서버 연결 대기: Supabase 프로젝트 설정이 필요합니다. 사진은 아직 서버에 저장되지 않았습니다.');
    client = client || root.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
    return {client, meet: c.meetId};
  }
  function check(result) { if(result.error) throw result.error; return result.data; }
  async function session() {
    const ctx = connection();
    const data = check(await ctx.client.auth.getSession());
    if(!data.session) throw new Error('심판 기록 화면에서 서버 계정으로 로그인한 후 다시 열어 주세요.');
    return ctx;
  }
  root.GalleryCloud = {
    async list() {
      const {client,meet} = await session();
      let all = [], from = 0;
      for (;;) {
        const rows = check(await client.from('meet_photos').select('*').eq('meet_id',meet).order('created_at',{ascending:false}).order('id').range(from,from+99));
        all.push(...rows);
        if(rows.length<100) break;
        from += 100;
      }
      return all.map(r=>({...r,created:Date.parse(r.created_at)}));
    },
    async url(row) {
      const {client} = await session();
      return check(await client.storage.from('meet-photos').createSignedUrl(row.path,3600)).signedUrl;
    },
    async save(row) {
      const {client,meet} = await session();
      const path = `${meet}/${row.id}`;
      check(await client.storage.from('meet-photos').upload(path,row.blob,{contentType:row.blob.type,upsert:false}));
      // If metadata fails the original is deliberately retained for administrator recovery.
      const result = await client.from('meet_photos').insert({id:row.id,meet_id:meet,path,name:row.name,category:row.category,caption:row.caption});
      if(result.error) throw new Error(`사진 원본은 업로드되었으나 목록 저장에 실패했습니다. 관리자 복구 경로: ${path}`);
    },
    async trash(id,restore=false) {
      const {client,meet} = await session();
      const rows = check(await client.from('meet_photos').update({deleted_at:restore?null:new Date().toISOString()}).eq('meet_id',meet).eq('id',id).select('id'));
      if(rows.length!==1) throw new Error('사진 변경 권한 또는 서버 상태를 확인해 주세요.');
    }
  };
})(globalThis);
