import { checkoutIntent } from './checkout-intent';

// Capture only the public offer before private setup removes its capability URL.
// This stores a selection; it never calls a checkout or payment endpoint.
checkoutIntent.capture(window.location.search);
