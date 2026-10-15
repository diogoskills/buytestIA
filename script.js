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
