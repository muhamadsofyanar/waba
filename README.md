# WA CRM pribadi — OneSender

MVP satu pengguna: kelola kontak, impor CSV, catat persetujuan, buat kampanye teks, jadwalkan, jeda/lanjutkan, dan pantau hasil pengajuan ke OneSender. Tidak ada pendaftaran publik atau tagihan SaaS.

## Cara deploy di Coolify

1. Upload seluruh isi folder ini ke **repository GitHub private** (tanpa `.env`).
2. Di Coolify pilih **Private Git Repository (with Deploy Key)**. Masukkan URL repository dan branch, lalu tambahkan deploy key yang diberikan Coolify ke GitHub pada **Settings → Deploy keys**. Pilih **Docker Compose** sebagai build/deploy jika Coolify meminta jenis aplikasi.
3. Atur environment variable dari `.env.example` lewat Coolify. `SESSION_SECRET` harus acak dan tetap sama setelah redeploy; contoh membuatnya: `openssl rand -hex 32`. Gunakan API URL **HTTPS** yang benar-benar valid dan API key dari halaman device OneSender. `STARSENDER_DEVICE_API_KEY` opsional, diambil dari menu device StarSender, bukan key akun. Jangan masukkan API key ke GitHub atau chat.
4. Arahkan domain melalui Coolify ke port aplikasi `3000` dan aktifkan HTTPS. Simpan volume `wa_crm_data` saat redeploy dan siapkan backup volume tersebut secara berkala.
5. Deploy lalu buka `/login`. Untuk revisi manual: unggah commit ke GitHub dan tekan **Redeploy** di Coolify. Jika menggunakan opsi Private Git (deploy key), deployment tidak otomatis.

VPS 4 vCPU/8 GB cukup sebagai titik awal untuk satu pengguna. Kode mengirim **satu pesan per interval** (minimal 15 detik), hanya ke kontak yang `consented` dan belum opt-out. Tidak ada janji keamanan nomor dari pemblokiran; patuhi izin penerima dan kebijakan penyedia.

## Impor dan kampanye

CSV UTF-8 dengan header `name,phone,tag,consent`. Nomor Indonesia `08...` diubah menjadi `628...`; nomor internasional dengan kode negara juga diterima. Isi `consent` dengan `yes`/`true`/`1` **hanya jika penerima sudah mengizinkan pesan WhatsApp**. Impor tidak otomatis memberi izin. Duplikat nomor diperbarui tanpa menghapus status berhenti berlangganan. Kolom tag opsional. Teks kampanye mendukung `{{name}}`. Kampanye memilih semua kontak berizin atau satu tag. Tinjau pratinjau dan jumlah penerima sebelum tombol Mulai.

Pilih OneSender atau StarSender untuk kampanye baru. Jika provider bermasalah, jeda kampanye dan pilih provider lain saat melanjutkan **sisa antrean**; ini tidak mengulang pesan sebelumnya. Respons sukses dicatat sebagai **diterima gateway**, bukan bukti tersampaikan ke WhatsApp. Jika request timeout atau respons tidak jelas, kampanye dijeda dan item berstatus `unknown`: jangan kirim ulang tanpa meninjau log perangkat untuk menghindari duplikasi. Kesalahan jelas disimpan sebagai `failed` dan tidak diulang otomatis. `STOP` harus diproses manual dengan menandai kontak opt-out; webhook balasan belum termasuk MVP.

## Batas versi awal

Satu API URL/key OneSender dan satu device StarSender opsional. Tambah sender lain dan sinkronisasi webhook di tahap berikutnya setelah alur satu sender diuji. Tidak ada pengiriman gambar/dokumen, sinkronisasi Chatwoot, dashboard deliverability, atau billing. Penyimpanan database SQLite ada di volume Docker, sehingga **volume wajib dipertahankan**. Ubah kata sandi admin melalui Coolify lalu redeploy; sesi lama tetap hidup maksimal 7 hari atau sampai `SESSION_SECRET` diganti.

## Uji lokal

Butuh Node.js 24+. Jalankan `npm test`, lalu isi environment dari `.env.example` secara aman dan jalankan `npm start`. Jangan memakai `http://` pada URL OneSender yang membawa API key.
