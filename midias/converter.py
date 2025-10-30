import os
import subprocess

def converter_gif_para_mp4_com_ffmpeg():
    # Diretório atual
    diretorio_atual = "."
    
    arquivos_encontrados = os.listdir(diretorio_atual)
    arquivos_gif = [f for f in arquivos_encontrados if f.lower().endswith('.gif')]

    if not arquivos_gif:
        print("Nenhum arquivo .gif encontrado neste diretório.")
        return

    print(f"Encontrados {len(arquivos_gif)} arquivos .gif. Iniciando conversão para MP4...")

    for nome_arquivo_gif in arquivos_gif:
        nome_base = os.path.splitext(nome_arquivo_gif)[0]
        nome_arquivo_mp4 = f"{nome_base}.mp4"
        
        caminho_completo_gif = os.path.join(diretorio_atual, nome_arquivo_gif)
        caminho_completo_mp4 = os.path.join(diretorio_atual, nome_arquivo_mp4)

        print(f"Convertendo '{nome_arquivo_gif}' para '{nome_arquivo_mp4}'...")

        # O filtro de vídeo exato que você pediu
        filtro_escala = "scale=trunc(iw/2)*2:trunc(ih/2)*2"

        # Aplicando todos os parâmetros solicitados, à risca:
        comando_ffmpeg = [
            'ffmpeg',
            '-i', caminho_completo_gif,
            '-c:v', 'libx264',
            '-profile:v', 'baseline',
            '-level', '3.0',
            '-pix_fmt', 'yuv420p',
            '-vf', filtro_escala,
            '-movflags', 'faststart',
            '-y',  # Sobrescreve o arquivo de saída sem perguntar
            caminho_completo_mp4
        ]

        try:
            # Executa o comando
            subprocess.run(comando_ffmpeg, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            print(f"Sucesso! '{nome_arquivo_mp4}' salvo.")
        
        except FileNotFoundError:
            print("\n*** ERRO CRÍTICO ***")
            print("O comando 'ffmpeg' não foi encontrado.")
            print("Por favor, instale o FFMPEG e certifique-se de que ele esteja no PATH do seu sistema.")
            return # Para o script
            
        except subprocess.CalledProcessError as e:
            # Se o ffmpeg falhar
            print(f"Erro ao converter '{nome_arquivo_gif}'.")
            print(f"Erro do FFMPEG: {e.stderr}")

    print("\nConversão concluída.")

if __name__ == "__main__":
    converter_gif_para_mp4_com_ffmpeg()