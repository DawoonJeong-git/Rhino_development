window.addEventListener("load", () => {
  const form = document.getElementById("handoffForm");

  if (form instanceof HTMLFormElement) {
    form.submit();
  }
});
