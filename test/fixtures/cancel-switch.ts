export default function(pi) {
  pi.on("session_before_switch", event => event.reason === "resume" ? { cancel: true } : undefined);
}
