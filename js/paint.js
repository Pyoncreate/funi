/* ふにのぬりえ(ブラウザ版)
 *
 * ぬりえのPNG(線画)を読み込んで、線で区切られた「領域」をタップすると
 * その領域を塗りつぶします。
 *
 * ぬりえを増やすときは、下の DESIGNS に1行足すだけです。
 */
(function () {
    'use strict';

    /* =========================================================
       設定
    ========================================================= */

    // ぬりえの一覧(id は半角英数字とハイフン、他と重ならない名前にします)
    const DESIGNS = [
        {
            id: 'hinatabokko',
            name: 'ひなたぼっこふに',
            src: 'images/coloring-01-hinatabokko.png',
            pdf: 'downloads/coloring-01-hinatabokko.pdf'
        },
        {
            id: 'pocket-funi',
            name: 'ぽけっとふに',
            src: 'images/coloring-02-pocket-funi.png',
            pdf: 'downloads/coloring-02-pocket-funi.pdf'
        }
    ];

    // 色のパレット
    const PALETTE = [
        { name: 'さくらいろ', value: '#f4b8c0' },
        { name: 'ももいろ', value: '#f9d3da' },
        { name: 'あか', value: '#ee8b8b' },
        { name: 'オレンジ', value: '#ffcf9e' },
        { name: 'きいろ', value: '#fff1a8' },
        { name: 'わかくさ', value: '#cfe8b0' },
        { name: 'ミント', value: '#b8e6d4' },
        { name: 'みずいろ', value: '#bfe3f5' },
        { name: 'あお', value: '#9ec5f0' },
        { name: 'むらさき', value: '#d4c1f0' },
        { name: 'ちゃいろ', value: '#c9a58b' },
        { name: 'はいいろ', value: '#a9a09b' },
        { name: 'しろ', value: '#ffffff' }
    ];

    // 作業用の画像サイズ(長いほうの辺)。大きいと重くなるので上限を決めています
    const MAX_SIDE = 1200;

    // 「線」とみなす濃さ(0〜1)。線が細い・うすいぬりえで塗れないときは小さくします
    const INK_THRESHOLD = 0.35;

    // 線の近くをタップしたとき、どこまでの距離(px)で近くの領域を探すか
    const SEARCH_RADIUS = 8;


    /* =========================================================
       画面の部品
    ========================================================= */

    const $ = function (id) { return document.getElementById(id); };

    const canvas = $('paint');
    const ctx = canvas.getContext('2d');
    const pickerEl = $('picker');
    const paletteEl = $('palette');
    const customEl = $('custom-color');
    const undoBtn = $('undo');
    const clearBtn = $('clear');
    const saveBtn = $('save');
    const statusEl = $('status');
    const pdfLink = $('pdf-link');

    // 読み込み済みのぬりえ(切り替えても塗った状態が残るように保存しておく)
    const cache = {};
    let current = null;      // いま表示中のぬりえ
    let currentColor = PALETTE[0].value;   // 選択中の色(null のときは消しゴム)
    let loadToken = 0;       // 切り替えが続けて起きたときの目印


    /* =========================================================
       ぬりえの読み込みと「領域」の下ごしらえ
    ========================================================= */

    function loadImage(src) {
        return new Promise(function (resolve, reject) {
            const img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('image-load')); };
            img.src = src;
        });
    }

    // PNGを読み込み、線で囲まれた領域ごとに番号(ラベル)をふる
    async function buildState(design) {
        const img = await loadImage(design.src);

        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const n = w * h;

        // 線画のピクセルを読み取る
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const tctx = tmp.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(img, 0, 0, w, h);
        const px = tctx.getImageData(0, 0, w, h).data;

        // 1ピクセルずつ「線かどうか」を判定する
        // (透明なPNGでも、白い背景のPNGでも動くように、
        //   「不透明さ × 暗さ」で線の濃さを出しています)
        const open = new Uint8Array(n);   // 1 = 塗れる場所 / 0 = 線
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const a = px[j + 3] / 255;
            const lum = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
            const ink = a * (255 - lum) / 255;
            open[i] = ink < INK_THRESHOLD ? 1 : 0;
        }

        // つながっている「塗れる場所」ごとに、番号をふる
        const labels = new Int32Array(n);   // 0 = 線(番号なし)
        const queue = new Int32Array(n);
        let count = 0;
        for (let start = 0; start < n; start++) {
            if (!open[start] || labels[start]) continue;
            count++;
            let head = 0;
            let tail = 0;
            queue[tail++] = start;
            labels[start] = count;
            while (head < tail) {
                const p = queue[head++];
                const x = p % w;
                if (x > 0 && open[p - 1] && !labels[p - 1]) { labels[p - 1] = count; queue[tail++] = p - 1; }
                if (x < w - 1 && open[p + 1] && !labels[p + 1]) { labels[p + 1] = count; queue[tail++] = p + 1; }
                if (p >= w && open[p - w] && !labels[p - w]) { labels[p - w] = count; queue[tail++] = p - w; }
                if (p < n - w && open[p + w] && !labels[p + w]) { labels[p + w] = count; queue[tail++] = p + w; }
            }
        }

        // 色を塗るための透明なレイヤー
        const layer = document.createElement('canvas');
        layer.width = w;
        layer.height = h;
        const lctx = layer.getContext('2d');
        const layerData = lctx.createImageData(w, h);

        return {
            design: design,
            img: img,
            w: w,
            h: h,
            labels: labels,
            colors: new Uint32Array(count + 1),   // 領域ごとの色(0 = 塗っていない)
            history: [],                          // 「もどす」用の記録
            layer: layer,
            lctx: lctx,
            layerData: layerData,
            layer32: new Uint32Array(layerData.data.buffer)
        };
    }


    /* =========================================================
       描画
    ========================================================= */

    // 白い紙 → 色のレイヤー → 線画(乗算) の順に重ねて表示する
    function render() {
        if (!current) return;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, current.w, current.h);
        ctx.drawImage(current.layer, 0, 0);
        // 乗算で重ねると、線画の白い部分は色を消さず、黒い線だけが残る
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(current.img, 0, 0, current.w, current.h);
        ctx.globalCompositeOperation = 'source-over';
    }

    // 1つの領域を、指定した色にする
    function paintRegion(state, label, color32) {
        const labels = state.labels;
        const layer32 = state.layer32;
        for (let i = 0; i < labels.length; i++) {
            if (labels[i] === label) layer32[i] = color32;
        }
        state.colors[label] = color32;
        state.lctx.putImageData(state.layerData, 0, 0);
        render();
    }

    // '#f4b8c0' → 画像データ用の数値(R, G, B, 不透明)
    function hexToUint32(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }


    /* =========================================================
       タップして塗る
    ========================================================= */

    // タップした場所(または、そのすぐ近く)の領域番号を返す
    function findLabel(state, x, y) {
        const w = state.w;
        const h = state.h;
        const labels = state.labels;
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        if (labels[y * w + x]) return labels[y * w + x];

        // 線の上をタップしたときは、近くの領域を探す
        for (let r = 1; r <= SEARCH_RADIUS; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const label = labels[ny * w + nx];
                    if (label) return label;
                }
            }
        }
        return 0;
    }

    function onCanvasClick(e) {
        if (!current) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
        const y = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);

        const label = findLabel(current, x, y);
        if (!label) return;

        const newColor = currentColor ? hexToUint32(currentColor) : 0;
        const prevColor = current.colors[label];
        if (newColor === prevColor) return;

        current.history.push({ label: label, prev: prevColor });
        paintRegion(current, label, newColor);
        updateButtons();
    }


    /* =========================================================
       ボタン
    ========================================================= */

    function updateButtons() {
        const hasHistory = !!current && current.history.length > 0;
        undoBtn.disabled = !hasHistory;
        clearBtn.disabled = !hasHistory;
        saveBtn.disabled = !current;
    }

    function undo() {
        if (!current || current.history.length === 0) return;
        const last = current.history.pop();
        paintRegion(current, last.label, last.prev);
        updateButtons();
    }

    function clearAll() {
        if (!current || current.history.length === 0) return;
        if (!window.confirm('ぬった色を、ぜんぶ消しますか?')) return;
        current.layer32.fill(0);
        current.colors.fill(0);
        current.history.length = 0;
        current.lctx.putImageData(current.layerData, 0, 0);
        render();
        updateButtons();
    }

    // 画像(PNG)として保存する。データはどこにも送信されません
    function save() {
        if (!current) return;
        canvas.toBlob(function (blob) {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'funi-nurie-' + current.design.id + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }, 'image/png');
    }

    function setStatus(text) {
        statusEl.textContent = text;
    }


    /* =========================================================
       パレットとぬりえの選択
    ========================================================= */

    function setActiveSwatch(activeBtn) {
        const buttons = paletteEl.querySelectorAll('button');
        buttons.forEach(function (b) {
            b.setAttribute('aria-pressed', b === activeBtn ? 'true' : 'false');
        });
    }

    function buildPalette() {
        PALETTE.forEach(function (c, index) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'paint-swatch';
            btn.style.backgroundColor = c.value;
            btn.setAttribute('aria-label', c.name);
            btn.setAttribute('title', c.name);
            btn.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
            btn.addEventListener('click', function () {
                currentColor = c.value;
                setActiveSwatch(btn);
            });
            paletteEl.appendChild(btn);
        });

        // 消しゴム(塗った色をもとにもどす)
        const eraser = document.createElement('button');
        eraser.type = 'button';
        eraser.className = 'paint-swatch paint-eraser';
        eraser.textContent = '消しゴム';
        eraser.setAttribute('aria-pressed', 'false');
        eraser.addEventListener('click', function () {
            currentColor = null;
            setActiveSwatch(eraser);
        });
        paletteEl.appendChild(eraser);

        // じぶんで選ぶ色
        customEl.addEventListener('input', function () {
            currentColor = customEl.value;
            setActiveSwatch(null);
        });
    }

    function buildPicker() {
        DESIGNS.forEach(function (d) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-id', d.id);
            btn.setAttribute('aria-pressed', 'false');

            const img = document.createElement('img');
            img.src = d.src;
            img.alt = '';
            img.loading = 'lazy';

            const label = document.createElement('span');
            label.textContent = d.name;

            btn.appendChild(img);
            btn.appendChild(label);
            btn.addEventListener('click', function () { showDesign(d); });
            pickerEl.appendChild(btn);
        });
    }

    async function showDesign(design) {
        const token = ++loadToken;
        setStatus('よみこみ中…');
        try {
            if (!cache[design.id]) {
                cache[design.id] = await buildState(design);
            }
            if (token !== loadToken) return;   // 別のぬりえに切り替わっていたら中止

            current = cache[design.id];
            canvas.width = current.w;
            canvas.height = current.h;
            render();

            pickerEl.querySelectorAll('button').forEach(function (b) {
                b.setAttribute('aria-pressed', b.getAttribute('data-id') === design.id ? 'true' : 'false');
            });
            pdfLink.href = design.pdf;
            pdfLink.textContent = '「' + design.name + '」をPDFで印刷する';
            canvas.setAttribute('aria-label', design.name + 'のぬりえ。塗りたい場所をタップすると色が塗られます');

            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', '#' + design.id);
            }
            setStatus('色をえらんで、ぬりたいところをタップしてね');
            updateButtons();
        } catch (err) {
            if (token !== loadToken) return;
            if (err && err.name === 'SecurityError') {
                setStatus('このページは、公開したサイトか、ローカルサーバー上で開いてください(ファイルを直接開くと動きません)');
            } else {
                setStatus('ぬりえを読み込めませんでした。時間をおいて、もういちど開いてね');
            }
        }
    }


    /* =========================================================
       はじめ
    ========================================================= */

    function init() {
        buildPalette();
        buildPicker();

        canvas.addEventListener('click', onCanvasClick);
        undoBtn.addEventListener('click', undo);
        clearBtn.addEventListener('click', clearAll);
        saveBtn.addEventListener('click', save);
        updateButtons();

        // URLの #pocket-funi のように指定されていれば、そのぬりえから始める
        const hash = window.location.hash.replace('#', '');
        const first = DESIGNS.find(function (d) { return d.id === hash; }) || DESIGNS[0];
        showDesign(first);
    }

    init();
})();