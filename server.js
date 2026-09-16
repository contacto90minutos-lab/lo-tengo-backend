const express = require('express');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());

// Token de prueba de Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "TEST-8144547530007879-060322-e0ded8a3c392321664c7768317956d1f-138917132";

// Inicializar cliente de Mercado Pago con el token de prueba
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// Base de datos en memoria / simulación sincronizada para el servidor
let pedidosGlobales = [
    {
        id: 101,
        comercio: "Andy O'clock",
        direccionComercio: "18 de Julio 1234, Montevideo",
        cliente: "Martina Claudino",
        direccionCliente: "Bv. Artigas 456, Montevideo",
        telefonoCliente: "099876543",
        total: 1250,
        estado: "Disponible para retirar",
        metodoPago: "Mercado Pago",
        pinRetiro: "4821",   // PIN requerido para que el comercio se lo entregue al cadete
        pinEntrega: "7823",  // PIN requerido para que el cadete se lo entregue al cliente
        cadeteAsignado: null,
        ciCadete: null,
        init_point: null     // Link real de pago de Mercado Pago Sandbox
    }
];

// Almacén en memoria para sesiones de usuarios (Login con Google)
let usuariosSesion = {};

// Endpoint para consultar pedidos
app.get('/api/pedidos', (req, res) => {
    res.json({ success: true, pedidos: pedidosGlobales });
});

// Endpoint para Autenticación con Google y persistencia de sesión
app.post('/api/auth/google', (req, res) => {
    const { token, email, name, picture, deviceId } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: "Datos de usuario inválidos" });
    }

    // Guardar sesión asociada al dispositivo o token local
    const sessionToken = token || 'session_' + Date.now();
    usuariosSesion[sessionToken] = {
        email,
        name,
        picture,
        deviceId: deviceId || 'default_device',
        lastLogin: new Date()
    };

    res.json({
        success: true,
        message: "Sesión iniciada correctamente",
        sessionToken,
        user: { email, name, picture }
    });
});

// Endpoint para crear o actualizar pedidos (incluye creación de preferencia real en Mercado Pago Sandbox)
app.post('/api/pedidos', async (req, res) => {
    const nuevoPedido = req.body;
    
    if (!nuevoPedido.id) {
        nuevoPedido.id = Date.now();
    }

    // Si es un pedido nuevo o requiere actualizar pago con Mercado Pago, generamos preferencia real
    if (nuevoPedido.metodoPago === "Mercado Pago" && (!nuevoPedido.init_point || nuevoPedido.forzarPreferencia)) {
        try {
            const preference = new Preference(mpClient);
            const preferenceResponse = await preference.create({
                body: {
                    items: [
                        {
                            title: nuevoPedido.tituloItem || `Pedido Lo Tengo #${nuevoPedido.id}`,
                            quantity: Number(nuevoPedido.cantidad || 1),
                            unit_price: Number(nuevoPedido.total || 100),
                            currency_id: 'UYU'
                        }
                    ],
                    back_urls: {
                        success: "https://www.mercadopago.com.uy",
                        failure: "https://www.mercadopago.com.uy",
                        pending: "https://www.mercadopago.com.uy"
                    },
                    auto_return: "approved",
                }
            });
            // Guardamos el init_point real de Sandbox devuelto por Mercado Pago
            nuevoPedido.init_point = preferenceResponse.init_point;
        } catch (error) {
            console.error("Error al crear preferencia en Mercado Pago:", error);
            // Fallback en caso de error de red con la API de MP
            nuevoPedido.init_point = `https://sandbox.mercadopago.com.uy/checkout/v1/redirect?pref_id=fallback_${nuevoPedido.id}`;
        }
    }

    // Generar PINs de seguridad automáticamente si es gastronomía y no los tiene
    if (!nuevoPedido.pinRetiro) {
        nuevoPedido.pinRetiro = Math.floor(1000 + Math.random() * 9000).toString();
    }
    if (!nuevoPedido.pinEntrega) {
        nuevoPedido.pinEntrega = Math.floor(1000 + Math.random() * 9000).toString();
    }

    const index = pedidosGlobales.findIndex(p => Number(p.id) === Number(nuevoPedido.id));
    if (index !== -1) {
        pedidosGlobales[index] = { ...pedidosGlobales[index], ...nuevoPedido };
    } else {
        pedidosGlobales.push(nuevoPedido);
    }
    
    res.json({ success: true, pedidos: pedidosGlobales, pedidoActualizado: nuevoPedido });
});

// Endpoint para validar PIN de Retiro (Comercio -> Cadete)
app.post('/api/pedidos/validar-retiro', (req, res) => {
    const { idPedido, pinIngresado } = req.body;
    const pedido = pedidosGlobales.find(p => Number(p.id) === Number(idPedido));

    if (!pedido) {
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }

    if (pedido.pinRetiro === pinIngresado) {
        pedido.estado = "En Camino";
        return res.json({ success: true, message: "PIN de retiro validado con éxito. Pedido en camino." });
    } else {
        return.status(400).json({ success: false, message: "PIN de retiro incorrecto." });
    }
});

// Endpoint para validar PIN de Entrega (Cadete -> Cliente)
app.post('/api/pedidos/validar-entrega', (req, res) => {
    const { idPedido, pinIngresado } = req.body;
    const pedido = pedidosGlobales.find(p => Number(p.id) === Number(idPedido));

    if (!pedido) {
        return.status(404).json({ success: false, message: "Pedido no encontrado" });
    }

    if (pedido.pinEntrega === pinIngresado) {
        pedido.estado = "Entregado";
        return res.json({ success: true, message: "PIN de entrega validado con éxito. Pedido completado." });
    } else {
        return res.status(400).json({ success: false, message: "PIN de entrega incorrecto." });
    }
});

// Servir archivos estáticos de las apps
app.use('/cliente', express.static(path.join(__dirname, 'AppCliente')));
app.use('/driver', express.static(path.join(__dirname, 'AppDriver')));
app.use('/empresa', express.static(path.join(__dirname, 'AppEmpresa')));
app.use('/panel', express.static(path.join(__dirname, 'AppPaneldecontrol')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de Lo Tengo corriendo en puerto ${PORT}`);
});