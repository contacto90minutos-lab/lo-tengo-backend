const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const server = http.createServer(app);

// Configuración de Socket.io para la comunicación en tiempo real con las Apps (Móviles / Web)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Servir la carpeta 'www' como el directorio estático principal de la raíz
app.use(express.static(path.join(__dirname, 'www')));

// Endpoint explícito para asegurar que el manifiesto se sirva correctamente sin errores
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Token de prueba de Mercado Pago (en standby / opcional)
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "TEST-8144547530007879-060322-e0ded8a3c392321664c7768317956d1f-138917132";
let mpClient = null;
try {
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
} catch (e) {
    console.log("Mercado Pago inicializado en modo simulación/standby.");
}

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
        metodoPago: "Efectivo / Simulado",
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
// GESTIÓN DE SOCKET.IO (Tiempo Real Móvil)
// ==========================================
io.on('connection', (socket) => {
    console.log(`Dispositivo conectado al servidor: ${socket.id}`);

    socket.on('registrar_dispositivo', (data) => {
        // data: { rol, zona }
        if (data && data.rol) {
            socket.join(data.rol);
        }
        if (data && data.zona) {
            socket.join(data.zona);
        }
        console.log(`Dispositivo ${socket.id} registrado con rol [${data?.rol || 'general'}]`);
    });

    socket.on('disconnect', () => {
        console.log(`Dispositivo desconectado: ${socket.id}`);
    });
});

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

    // Notificar en tiempo real a las apps conectadas
    io.emit('actualizacion_catalogo', productosGlobales);
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

    // Notificar al panel y supervisores en tiempo real
    io.emit('nuevo_turno_registrado', turno);
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
// ENDPOINTS DE PEDIDOS Y MERCADO PAGO (Standby / Simulación)
// ==========================================

app.post('/api/pedidos', async (req, res) => {
    const nuevoPedido = req.body;
    
    if (!nuevoPedido.id) {
        nuevoPedido.id = Date.now();
    }

    // Si está habilitado MP y se solicita explícitamente, intenta crear preferencia, de lo contrario opera en modo fluido
    if (nuevoPedido.metodoPago === "Mercado Pago" && mpClient && (!nuevoPedido.init_point || nuevoPedido.forzarPreferencia)) {
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
            console.error("Aviso: Mercado Pago en standby o error de credenciales, usando enlace simulado:", error.message);
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
    
    // TRANSMISIÓN INSTANTÁNEA POR SOCKET.IO A LAS APPS MÓVILES
    io.emit('pedido_actualizado', { tipo: index !== -1 ? 'modificado' : 'nuevo', pedido: nuevoPedido });

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
        io.emit('pedido_actualizado', { tipo: 'estado_cambiado', pedido });
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
        io.emit('pedido_actualizado', { tipo: 'estado_cambiado', pedido });
        return res.json({ success: true, message: "PIN de entrega validado con éxito. Pedido completado." });
    } else {
        return res.status(400).json({ success: false, message: "PIN de entrega incorrecto." });
    }
});

// Servir archivos estáticos de las sub-apps adicionales
app.use('/cliente', express.static(path.join(__dirname, 'AppCliente')));
app.use('/driver', express.static(path.join(__dirname, 'AppDriver')));
app.use('/empresa', express.static(path.join(__dirname, 'AppEmpresa')));
app.use('/panel', express.static(path.join(__dirname, 'AppPaneldecontrol')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[LO TENGO] Servidor operativo y corriendo en puerto ${PORT} con WebSockets y sincronización en tiempo real.`);
});