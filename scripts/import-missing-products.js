/**
 * One-off: import products present on the client WooCommerce site but missing from
 * the web DB. Uploads each image to Bunny CDN, then EMITS a .sql file that inserts
 * Product + images + description + color option + region links per product using
 * CTEs (one statement per product → minimal round-trips, avoids the remote-DB
 * interactive-transaction timeout). Run the emitted SQL with psql.
 *
 *   node scripts/import-missing-products.js        # uploads + writes import.sql
 */
require('dotenv').config();
const fs = require('fs');

const S = '/private/tmp/claude-501/-Users-tecaudex-Amoonis/e9b8dccc-81f7-4d83-a8ab-9a336418614e/scratchpad';
const WOO = `${S}/woo_products.json`;
const OUT = `${S}/import.sql`;
const B = {
  zone: process.env.BUNNY_STORAGE_ZONE, key: process.env.BUNNY_STORAGE_ACCESS_KEY,
  region: process.env.BUNNY_STORAGE_REGION, cdn: process.env.BUNNY_IMAGES_CDN_HOSTNAME,
};
const TARGETS = ['rattan box baby boy','rattan box baby girl','new care box','bow box for girls','bunny acrylic box'];
const norm = (s)=>(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const slug = (s)=>norm(s).replace(/ /g,'-');
const strip = (s)=>(s||'').replace(/<[^>]+>/g,' ').replace(/&#8217;|&#8216;/g,'’').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#[0-9]+;/g,'').replace(/\s+/g,' ').trim();
const dq = (s)=>`$d$${(s||'')}$d$`;                       // dollar-quote (safe for quotes/emojis)
const arr = (a)=>`ARRAY[${a.map((x)=>dq(x)).join(',')}]::text[]`;

async function upload(src, dest){
  const r = await fetch(src); if(!r.ok) throw new Error('dl '+r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const put = await fetch(`https://${B.region}/${B.zone}/${dest}`,{method:'PUT',headers:{AccessKey:B.key,'Content-Type':r.headers.get('content-type')||'image/jpeg'},body:buf});
  if(put.status!==201&&put.status!==200) throw new Error('up '+put.status);
  return `https://${B.cdn}/${dest}`;
}
const wooColors=(p)=>{ for(const a of p.attributes||[]) if((a.name||'').toLowerCase()==='color') return (a.terms||[]).map(t=>t.name); return []; };
const wooPrice=(p)=>{ const pr=p.prices||{}; return Math.round(Number(pr.price)/10**(pr.currency_minor_unit??2)*100)/100; };

(async()=>{
  const woo = JSON.parse(fs.readFileSync(WOO,'utf8'));
  const parts = ['BEGIN;'];
  for(const key of TARGETS){
    const p = woo.find(x=>norm(x.name)===key);
    if(!p){ console.log('!! not in woo:',key); continue; }
    const srcs=[...new Set((p.images||[]).map(i=>i.src))].slice(0,10);
    const urls=[]; let i=0;
    for(const src of srcs){ try{ const ext=(src.split('?')[0].split('.').pop()||'jpeg'); urls.push(await upload(src,`products/imported/${slug(p.name)}/${i}.${ext}`)); i++; }catch(e){ console.log('  img fail',src,e.message);} }
    const colors=wooColors(p);
    const catName=(p.categories?.[0]?.name||'');
    const price=wooPrice(p);
    const subtitle=strip(p.short_description).slice(0,200);
    const desc=strip(p.description);
    const imgValues = urls.map((u,idx)=>`(${dq(u)},${idx})`).join(',') || null;
    const optCte = colors.length
      ? `, opt AS (INSERT INTO "ProductOption"(id,"productId",title,options) SELECT gen_random_uuid()::text, np.id, 'Color', ${arr(colors)} FROM np)`
      : '';
    const imgCte = imgValues
      ? `, imgs AS (INSERT INTO "ProductImage"(id,"productId",url,"sortOrder") SELECT gen_random_uuid()::text, np.id, v.url, v.ord FROM np, (VALUES ${imgValues}) AS v(url,ord))`
      : '';
    parts.push(`
-- ${p.name}
DELETE FROM "Product" WHERE title = ${dq(p.name)};
WITH np AS (
  INSERT INTO "Product"(id,title,subtitle,price,status,quantity,"categoryId","giftCardEnabled","updatedAt")
  SELECT gen_random_uuid()::text, ${dq(p.name)}, ${dq(subtitle)}, ${price}, 'PUBLISHED', 100,
         (SELECT id FROM "Category" WHERE lower(title)=lower(${dq(catName)}) LIMIT 1), true, now()
  RETURNING id
)${imgCte}${optCte}
, dsc AS (INSERT INTO "ProductDescription"(id,"productId",title,description,"sortOrder") SELECT gen_random_uuid()::text, np.id, 'Description', ${dq(desc)}, 0 FROM np)
, reg AS (INSERT INTO "ProductRegion"("productId","regionId") SELECT np.id, r.id FROM np, "Region" r WHERE r."isActive"=true)
SELECT ${dq(p.name)} AS imported, (SELECT count(*) FROM np);`);
    console.log(`prepared: ${p.name} | AED ${price} | cat=${catName} | imgs=${urls.length} | colors=[${colors.join(',')}]`);
  }
  parts.push('COMMIT;');
  fs.writeFileSync(OUT, parts.join('\n'));
  console.log('\nSQL written ->', OUT);
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
