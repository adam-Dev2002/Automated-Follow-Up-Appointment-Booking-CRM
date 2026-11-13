(() => {
    'use strict';
    async function print() {
        await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
        await document.fonts.ready;
        window.print();
    }
    document.getElementById('print-receipt').addEventListener('click', print);
    if (new URLSearchParams(location.search).get('print') === '1') print();
})();
