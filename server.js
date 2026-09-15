const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Token de prueba de Mercado Pago que sacaste de la pantalla
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "TEST-8144547530007879-060322-e0ded8a3c392321664c7768317956d1f-138917132";

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
        codigoVerificacion: "7823",
        cadeteAsignado: null,
        ciCadete: null,
        init_point: null // Link de pago de Mercado Pago
    }
];

// Endpoint para consultar pedidos
app.get('/api/pedidos', (req, res) => {
    res.json({ success: true, pedidos: pedidosGlobales });
});

// Endpoint para crear o actualizar pedidos (y generar preferencia en Mercado Pago Sandbox)
app.post('/api/pedidos', async (req, res) => {
    const nuevoPedido = req.body;
    if (!nuevoPedido.id) {
        nuevoPedido.id = Date.now();
    }

    // Si eligió Mercado Pago, simulamos/generamos el link de pago de prueba
    if (nuevoPedido.metodoPago === "Mercado Pago") {
        nuevoPedido.init_point = "https://sandbox.mercadopago.com.uy/checkout/v1/redirect?pref_id=test-preference-123456";
    }

    const index = pedidosGlobales.findIndex(p => Number(p.id) === Number(nuevoPedido.id));
    if (index !== -1) {
        pedidosGlobales[index] = { ...pedidosGlobales[index], ...nuevoPedido };
    } else {
        pedidosGlobales.push(nuevoPedido);
    }
    
    res.json({ success: true, pedidos: pedidosGlobales });
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