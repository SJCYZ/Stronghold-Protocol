export default function setup(sp) {
  // Native room control applies the host's changes through this match clock; retain its chosen speed between phases.
  sp.clock.onPhase(() => {});
}
