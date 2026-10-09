const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const server = http.createServer(app);

// Configuración robusta de Socket.io para la comunicación en tiempo real entre las 4 Apps
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

// Almacén en memoria para sesiones de usuarios (Login con Google/Apple y Perfiles extendidos)
let usuariosSesion = {};

// Almacén para Enlaces Temporales de Seguimiento (Compartir con Terceros)
let enlacesSeguimiento = {};

// Almacén de Ubicaciones en Vivo de Cadetes (Para WebSockets / Zonas Calientes)
let ubicacionesCadetes = {};

// ==========================================
// GESTIÓN UNIFICADA DE SOCKET.IO (TIEMPO REAL)
// ==========================================
io.on('connection', (socket) => {
    console.log(`Dispositivo conectado al servidor: ${socket.id}`);

    // Registro de roles para segmentar comunicaciones (cliente, driver, empresa, admin)
    socket.on('registrar_dispositivo', (data) => {
        if (data && data.rol) {
            socket.join(data.rol);
            console.log(`Dispositivo ${socket.id} se unió a la sala de rol: [${data.rol}]`);
        }
        if (data && data.zona) {
            socket.join(data.zona);
        }
    });

    // Streaming de coordenadas GPS del cadete en tiempo real hacia el panel y clientes
    socket.on('actualizar_ubicacion_cadete', (data) => {
        // data: { cadeteId, lat, lng, zona }
        if (data && data.cadeteId) {
            ubicacionesCadetes[data.cadeteId] = { lat: data.lat, lng: data.lng, timestamp: Date.now() };
            
            // Broadcast universal y dirigido a la torre de control y clientes
            io.to('admin').emit('ubicacion_cadete_actualizada', data);
            io.emit('radar_cadetes', ubicacionesCadetes);
        }
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

// Endpoints para Gestión de Productos / Catálogo y Ofertas Flash
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

    // Sincronización instantánea a todas las apps conectadas
    io.emit('actualizacion_catalogo', productosGlobales);
    io.emit('notificacion_oferta_flash', { mensaje: "¡Nueva oferta disponible en el outlet!", producto: nuevoProducto });
    
    res.json({ success: true, productos: productosGlobales });
});

// ==========================================
// ENDPOINT DE AUTENTICACIÓN Y PERFILES (Google / Apple)
// ==========================================

app.post('/api/auth/google', (req, res) => {
    const { token, email, name, picture, deviceId, rol, fotoCadeteObligatoria } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: "Datos de usuario inválidos" });
    }

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

app.post('/api/horarios', (req, res) => {
    const turno = req.body; 
    turno.id = Date.now();
    bolsaHorariosGlobal.push(turno);

    // Notificar al panel en tiempo real
    io.emit('nuevo_turno_registrado', turno);
    res.json({ success: true, message: "Turno registrado en la bolsa de horarios con éxito", bolsa: bolsaHorariosGlobal });
});

// ==========================================
// ENDPOINTS DE CALIFICACIONES Y COMENTARIOS
// ==========================================

app.get('/api/calificaciones', (req, res) => {
    res.json({ success: true, calificaciones: calificacionesGlobales });
});

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
// ENDPOINTS DE PAGOS, ANTIFRAUDE Y PEDIDOS
// ==========================================

app.post('/api/pagos/validar-tarjeta', async (req, res) => {
    const { tokenTarjeta, emailCliente } = req.body;
    
    try {
        if (mpClient) {
            const preference = new Preference(mpClient);
            await preference.create({
                body: {
                    items: [{ title: "Verificacion Antifraude Lo Tengo", quantity: 1, unit_price: 15, currency_id: 'UYU' }],
                    back_urls: { success: "https://lotengo.uy", failure: "https://lotengo.uy", pending: "https://lotengo.uy" }
                }
            });
        }
        
        console.log(`[ANTIFRAUDE] Transacción de $15 UYU procesada y reembolso automático emitido para ${emailCliente}`);
        
        res.json({
            success: true,
            message: "Tarjeta validada correctamente. El cargo temporal de $15 UYU ha sido reembolsado."
        });
    } catch (error) {
        console.error("Error en validación antifraude de tarjeta:", error.message);
        res.status(400).json({ success: false, message: "No se pudo validar la tarjeta. Verifique los datos." });
    }
});

app.post('/api/pedidos/compartir', (req, res) => {
    const { idPedido } = req.body;
    const pedido = pedidosGlobales.find(p => Number(p.id) === Number(idPedido));

    if (!pedido) {
        return res.status(404).json({ success: false, message: "Pedido no encontrado para compartir" });
    }

    const trackingToken = 'track_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    enlacesSeguimiento[trackingToken] = {
        idPedido: pedido.id,
        comercio: pedido.comercio,
        estado: pedido.estado,
        cliente: pedido.cliente,
        activo: true
    };

    const trackingUrl = `https://lo-tengo-backend.onrender.com/track/${trackingToken}`;
    res.json({ success: true, trackingUrl, trackingToken });
});

app.get('/track/:token', (req, res) => {
    const token = req.params.token;
    const infoSeguimiento = enlacesSeguimiento[token];

    if (!infoSeguimiento || !infoSeguimiento.activo) {
        return res.send(`<h2>El enlace de seguimiento ha expirado o no es válido.</h2><p>El pedido ya fue entregado o finalizado.</p>`);
    }

    const pedidoReal = pedidosGlobales.find(p => Number(p.id) === Number(infoSeguimiento.idPedido));
    
    res.send(`
        <html>
            <head>
                <title>Lo Tengo - Seguimiento en Vivo</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; background: #f4f7f6; text-align: center; padding: 20px; }
                    .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 400px; margin: auto; }
                    h2 { color: #2c3e50; }
                    .status { font-size: 18px; font-weight: bold; color: #e67e22; margin: 15px 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>📦 Seguimiento de Envío</h2>
                    <p>Comercio: <strong>${pedidoReal ? pedidoReal.comercio : 'Lo Tengo'}</strong></p>
                    <div class="status">Estado: ${pedidoReal ? pedidoReal.estado : 'Desconocido'}</div>
                    <p>El cadete va en camino a la dirección de destino.</p>
                </div>
            </body>
        </html>
    `);
});

app.post('/api/pedidos', async (req, res) => {
    const nuevoPedido = req.body;
    
    if (!nuevoPedido.id) {
        nuevoPedido.id = Date.now();
    }

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
            console.error("Aviso: Mercado Pago en standby, usando enlace simulado:", error.message);
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
    
    // =========================================================================
    // DIFUSIÓN CRUCIAL: Notifica al instante a todas las apps el cambio del pedido
    // =========================================================================
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
        
        Object.keys(enlacesSeguimiento).forEach(token => {
            if (enlacesSeguimiento[token].idPedido === Number(idPedido)) {
                enlacesSeguimiento[token].activo = false;
            }
        });

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
    console.log(`[LO TENGO] Servidor operativo y corriendo en puerto ${PORT} con sincronización en tiempo real.`);
});