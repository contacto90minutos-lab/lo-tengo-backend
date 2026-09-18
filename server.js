const express = require('express');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Endpoint explícito para asegurar que el manifiesto se sirva correctamente sin errores
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

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
        pinRetiro: "4821",   
        pinEntrega: "7823",  
        cadeteAsignado: null,
        ciCadete: null,
        init_point: null     
    }
];

// Almacén de Productos (Sincronización App Comercios <-> Cliente)
let productosGlobales = [];

// Almacén para Bolsa de Horarios de Cadetes (Disponibilidad por demanda)
let bolsaHorariosGlobal = [];

// Almacén para Calificaciones y Comentarios (Cadetes y Comercios)
let calificacionesGlobales = [];

// Almacén en memoria para sesiones de usuarios (Login con Google y Perfiles extendidos ej. foto obligatoria cadetes)
let usuariosSesion = {};

// ==========================================
// ENDPOINTS DE PEDIDOS Y CATÁLOGO
// ==========================================

app.get('/api/pedidos', (req, res) => {
    res.json({ success: true, pedidos: pedidosGlobales });
});

// Endpoints para Gestión de Productos / Catálogo
app.get('/api/productos', (req, res) => {
    res.json({ success: true, productos: productosGlobales });
});

app.post('/api/productos', (req, res) => {
    const nuevoProducto = req.body;
    if (!nuevoProducto.id) nuevoProducto.id = Date.now();
    
    const index = productosGlobales.findIndex(p => Number(p.id) === Number(nuevoProducto.id));
    if (index !== -1) {
        productosGlobales[index] = { ...productosGlobales[index], ...nuevoProducto };
    } else {
        productosGlobales.push(nuevoProducto);
    }
    res.json({ success: true, productos: productosGlobales });
});

// ==========================================
// ENDPOINT DE AUTENTICACIÓN Y PERFILES (Google)
// ==========================================

app.post('/api/auth/google', (req, res) => {
    const { token, email, name, picture, deviceId, rol, fotoCadeteObligatoria } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: "Datos de usuario inválidos" });
    }

    // Validación estricta para cadetes: si es rol driver, exigimos foto de perfil
    if (rol === 'driver' && !picture && !fotoCadeteObligatoria) {
        return res.status(400).json({ success: false, message: "La foto de perfil es obligatoria para los cadetes." });
    }

    const sessionToken = token || 'session_' + Date.now();
    usuariosSesion[sessionToken] = {
        email,
        name,
        picture: picture || fotoCadeteObligatoria || '',
        rol: rol || 'cliente',
        deviceId: deviceId || 'default_device',
        lastLogin: new Date()
    };

    res.json({
        success: true,
        message: "Sesión iniciada correctamente",
        sessionToken,
        user: { email, name, picture: usuariosSesion[sessionToken].picture, rol: usuariosSesion[sessionToken].rol }
    });
});

// ==========================================
// ENDPOINTS DE LOGÍSTICA Y BOLSA DE HORARIOS
// ==========================================

app.get('/api/horarios', (req, res) => {
    res.json({ success: true, horarios: bolsaHorariosGlobal });
});

// Los cadetes se anotan en la bolsa de turnos según demanda
app.post('/api/horarios', (req, res) => {
    const turno = req.body; // { cadeteEmail, cadeteNombre, horaInicio, horaFin, zona }
    turno.id = Date.now();
    bolsaHorariosGlobal.push(turno);
    res.json({ success: true, message: "Turno registrado en la bolsa de horarios con éxito", bolsa: bolsaHorariosGlobal });
});

// ==========================================
// ENDPOINTS DE CALIFICACIONES Y COMENTARIOS
// ==========================================

app.get('/api/calificaciones', (req, res) => {
    res.json({ success: true, calificaciones: calificacionesGlobales });
});

// Permite dejar estrellas y comentarios escritos a cadetes o empresas
app.post('/api/calificaciones', (req, res) => {
    const { tipo, objetivoId, evaluadorEmail, estrellas, comentario } = req.body; 
    // tipo: 'cadete' o 'comercio'
    
    if (!estrellas || !objetivoId) {
        return res.status(400).json({ success: false, message: "Faltan datos en la calificación" });
    }

    const nuevaCalificacion = {
        id: Date.now(),
        tipo,
        objetivoId,
        evaluadorEmail,
        estrellas: Number(estrellas),
        comentario: comentario || "",
        fecha: new Date()
    };

    calificacionesGlobales.push(nuevaCalificacion);
    res.json({ success: true, message: "Calificación registrada correctamente", calificaciones: calificacionesGlobales });
});

// ==========================================
// ENDPOINTS DE PEDIDOS Y MERCADO PAGO
// ==========================================

app.post('/api/pedidos', async (req, res) => {
    const nuevoPedido = req.body;
    
    if (!nuevoPedido.id) {
        nuevoPedido.id = Date.now();
    }

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
            nuevoPedido.init_point = preferenceResponse.init_point;
        } catch (error) {
            console.error("Error al crear preferencia en Mercado Pago:", error);
            nuevoPedido.init_point = `https://sandbox.mercadopago.com.uy/checkout/v1/redirect?pref_id=fallback_${nuevoPedido.id}`;
        }
    }

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
        return res.status(400).json({ success: false, message: "PIN de retiro incorrecto." });
    }
});

app.post('/api/pedidos/validar-entrega', (req, res) => {
    const { idPedido, pinIngresado } = req.body;
    const pedido = pedidosGlobales.find(p => Number(p.id) === Number(idPedido));

    if (!pedido) {
        return res.status(404).json({ success: false, message: "Pedido no encontrado" });
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
