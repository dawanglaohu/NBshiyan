import sharp from 'sharp';
const O='/workspace/nb3d-v3/tex/';
const w=(f,W,H,b)=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${b}</svg>`),{density:144}).png().toFile(O+f);
const C='#E8573F'; // coral
// corrugated side print (coral ink on transparent)
await w('corr_print.png',1024,512,`<g fill="${C}" font-family="Inter" font-weight="800"><text x="60" y="150" font-size="96">PackJoyU</text></g>
<g fill="${C}" font-family="Inter" font-weight="600"><text x="64" y="205" font-size="30" letter-spacing="4">CORRUGATED SHIPPING CARTON</text></g>
<g transform="translate(830,80)" fill="${C}"><path d="M20 140 V40 H0 L35 0 L70 40 H50 V140Z"/><path d="M100 140 V40 H80 L115 0 L150 40 H130 V140Z"/><rect x="0" y="150" width="150" height="10"/></g>
<g transform="translate(70,330)" stroke="${C}" stroke-width="7" fill="none" stroke-linecap="round"><path d="M0 60 A60 60 0 0 1 120 60 Z"/><path d="M60 60 V120 a12 12 0 0 1 -24 0"/><path d="M20 -6 l-8 14 M60 -14 l-8 14 M100 -6 l-8 14"/></g>
<g transform="translate(860,330)" stroke="${C}" stroke-width="7" fill="none"><path d="M10 10 h70 l-12 60 h-46z"/><path d="M45 70 v35 M20 110 h50"/></g>`);
// shipping label (opaque)
await w('corr_label.png',512,384,`<rect width="512" height="384" fill="#fbfaf6"/><g fill="#1b1b1b" font-family="Inter"><text x="24" y="50" font-size="30" font-weight="800">SHIP TO</text><rect x="24" y="72" width="300" height="14"/><rect x="24" y="100" width="240" height="14"/><rect x="24" y="128" width="270" height="14"/>${Array.from({length:70},(_,i)=>`<rect x="${24+i*6.6}" y="200" width="${1+(i*7)%4}" height="120"/>`).join('')}<text x="24" y="355" font-size="22">PJU 0000 1234 5678</text></g>`);
// tape (semi-opaque tan, full)
await w('tape.png',64,64,`<rect width="64" height="64" fill="#c8a06a"/>`);
// gold foil masks (white on transparent)
await w('gift_foil.png',1024,1024,`<g fill="#fff" text-anchor="middle"><text x="512" y="540" font-family="Cormorant Garamond" font-size="104" font-weight="600" letter-spacing="14">PACKJOYU</text><text x="512" y="610" font-family="Inter" font-size="24" letter-spacing="16">LUXURY PACKAGING</text></g><rect x="60" y="60" width="904" height="904" fill="none" stroke="#fff" stroke-width="6"/><rect x="80" y="80" width="864" height="864" fill="none" stroke="#fff" stroke-width="2"/>`);
await w('wine_foil.png',512,1536,`<rect x="30" y="30" width="452" height="1476" fill="none" stroke="#fff" stroke-width="5"/><rect x="44" y="44" width="424" height="1448" fill="none" stroke="#fff" stroke-width="2"/><g fill="#fff" text-anchor="middle"><path d="M256 560 l34 60 l-34 60 l-34 -60z"/><text x="256" y="800" font-family="Cormorant Garamond" font-size="96" font-weight="600" letter-spacing="10">RÉSERVE</text><text x="256" y="860" font-family="Inter" font-size="26" letter-spacing="14">GRAND CRU · MMXXII</text><text x="256" y="1300" font-family="Cormorant Garamond" font-size="44" letter-spacing="12">PACKJOYU</text></g>`);
await w('bottle_label.png',1024,512,`<rect width="1024" height="512" fill="#efe6d2"/><rect x="20" y="20" width="984" height="472" fill="none" stroke="#7a5b2e" stroke-width="4"/><g text-anchor="middle" fill="#2a1d12"><text x="512" y="210" font-family="Cormorant Garamond" font-size="110" font-weight="600">Château Lumière</text><text x="512" y="290" font-family="Inter" font-size="34" letter-spacing="10">CABERNET SAUVIGNON</text><text x="512" y="380" font-family="Cormorant Garamond" font-size="60">2022</text></g>`);
console.log('ok');
await w('wine_lid_foil.png',512,512,`<rect x="30" y="30" width="452" height="452" fill="none" stroke="#fff" stroke-width="5"/><rect x="44" y="44" width="424" height="424" fill="none" stroke="#fff" stroke-width="2"/><path d="M256 196 l34 60 l-34 60 l-34 -60z" fill="#fff"/>`);
