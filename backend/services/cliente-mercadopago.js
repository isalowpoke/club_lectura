import { MercadoPagoConfig, Payment, PreApproval, Preference } from 'mercadopago';

// El SDK modifica config.options por llamada. Una config nueva evita compartir
// claves de idempotencia entre usuarios o solicitudes concurrentes.
export function crearClienteMercadoPago(accessToken) {
  const config = () => new MercadoPagoConfig({ accessToken, options: { timeout: 4000, maxRetries: 0 } });
  return {
    obtenerPago: (id) => new Payment(config()).get({ id }),
    obtenerAcuerdo: (id) => new PreApproval(config()).get({ id }),
    crearAcuerdo: (body, token) => new PreApproval(config()).create({ body, requestOptions: { idempotencyKey: token } }),
    cancelarAcuerdo: (id) => new PreApproval(config()).update({ id, body: { status: 'cancelled' } }),
    crearPreferencia: (body, compraId) => new Preference(config()).create({ body, requestOptions: { idempotencyKey: compraId } }),
  };
}
