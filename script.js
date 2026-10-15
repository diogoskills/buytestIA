const modal = document.querySelector('#premium-modal');
const feedback = document.querySelector('#premium-feedback');

for (const id of ['open-premium', 'banner-premium']) {
  document.getElementById(id).addEventListener('click', () => modal.showModal());
}
document.querySelector('#close-premium').addEventListener('click', () => modal.close());
modal.addEventListener('click', (event) => {
  const rect = modal.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
});
document.querySelector('#subscribe').addEventListener('click', () => {
  feedback.hidden = false;
});

let cartCount = 0;
let toastTimeout;
const toast = document.querySelector('#toast');
document.querySelectorAll('.buy-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('#cart-count').textContent = ++cartCount;
    toast.textContent = `${button.dataset.product} adicionado à sacola!`;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 3500);
  });
});
